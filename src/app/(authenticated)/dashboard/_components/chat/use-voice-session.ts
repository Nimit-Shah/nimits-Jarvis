"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceInput } from "./use-voice-input";
import { useMicPermission } from "./use-mic-permission";
import type { MicPermissionState } from "./use-mic-permission";
import { toSpeakable } from "./voice-speakable";

/**
 * Claude-exact session.
 * Loop: IDLE → LISTENING → TRANSCRIBING → THINKING → SPEAKING → LISTENING (auto-loop).
 * No GREETING; no overlay. Barge-in: sustained mic energy during SPEAKING stops
 * playback and re-arms LISTENING.
 *
 * Fixes applied (Opus-5 audit):
 *  - Bug 1: state held in stateRef, read inside async callbacks — processQueue's
 *    tail check now sees SPEAKING and auto-loops to LISTENING (stale-closure fix).
 *  - Bug 2: TTS cancellation is per-utterance AbortController — barge-in stop
 *    aborts the in-flight fetch but never leaves a sticky `cancelled` flag, so
 *    speech always resumes after a barge-in.
 *  - Bug 3: sentence offset advances by regex lastIndex (untrimmed consumed
 *    length); trim only the TTS payload — no more 1-char drift per sentence.
 *  - Bug 5: barge-in requires sustained energy (VOLUME 55, ~9 consecutive polls
 *    ≈ 300ms) and capture requests AEC — own-voice no longer triggers it.
 *  - Prefetch: next sentence's TTS fetch starts while the current one plays.
 *  - Timing trace: t_stt_done → t_first_token → t_first_audio logged for
 *    latency budget measurement.
 *  - whisper-status: retried with backoff + refetch on focus; openVoice shows
 *    a reason instead of silently no-oping.
 */

export type VoiceSessionState = "IDLE" | "LISTENING" | "TRANSCRIBING" | "THINKING" | "SPEAKING" | "ERROR";

interface UseVoiceSessionOptions {
  instanceId?: string;
  sttModel?: string;
  ttsVoice?: string;
  ttsProvider?: string;
  /** Free-text Fish voice steering — pinned per request for one consistent voice */
  voiceStyle?: string;
  onSend: (text: string) => void;
  isAgentStreaming: boolean;
  latestAssistantText?: string;
  latestAssistantMessageId?: string;
  onOptimisticTranscript?: (text: string) => void;
}

interface UseVoiceSessionReturn {
  isVoiceActive: boolean;
  state: VoiceSessionState;
  micPermission: MicPermissionState;
  volume: number;
  lastTranscription: string;
  /** Growing interim transcription shown while the user is still speaking */
  liveTranscript: string;
  voiceError: string | null;
  whisperAvailable: boolean;
  openVoice: () => void;
  closeVoice: () => void;
  stopAll: () => void;
  requestMicPermission: () => Promise<boolean>;
}

// ── TTS engine: per-utterance AbortController + one-sentence prefetch ─────────

function createTts(getCfg: () => { voice?: string; provider?: string; instanceId?: string; voiceStyle?: string }) {
  let currentAudio: HTMLAudioElement | null = null;
  let currentUrl: string | null = null;
  // Per-utterance abort: barge-in aborts THIS fetch; the next speak() creates a
  // fresh controller — no sticky flag that silences all later sentences (Bug 2).
  let fetchCtrl: AbortController | null = null;
  let playbackToken = 0;
  // Reject handle for the in-flight playback promise — pausing a playing audio
  // element never fires onended/onerror, so stop() must settle it explicitly
  // or processQueue would await forever (deadlock → speakingRef stuck true).
  let pendingReject: ((e: Error) => void) | null = null;

  // Prefetch pool: keyed by sentence text, max 2 in flight (current + next)
  const prefetchMap = new Map<string, Promise<{ blob: Blob; provider: string }>>();

  async function fetchTts(text: string): Promise<{ blob: Blob; provider: string }> {
    const cfg = getCfg();
    const qs = cfg.instanceId ? `?instanceId=${encodeURIComponent(cfg.instanceId)}` : "";
    fetchCtrl = new AbortController();
    const myCtrl = fetchCtrl;
    const res = await fetch(`/api/tts${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: cfg.voice, provider: cfg.provider, voiceStyle: cfg.voiceStyle }),
      signal: myCtrl.signal,
    });
    if (!res.ok) throw new Error(`TTS failed (${res.status})`);
    const provider = res.headers.get("X-TTS-Provider") ?? "unknown";
    const blob = await res.blob();
    void myCtrl; // controller kept for abort-on-stop
    return { blob, provider };
  }

  /** Start fetching a sentence now so it's ready when its turn comes. */
  function prefetch(text: string) {
    if (!text || prefetchMap.has(text) || prefetchMap.size >= 2) return;
    const p = fetchTts(text).catch((e) => {
      prefetchMap.delete(text);
      throw e;
    });
    prefetchMap.set(text, p);
  }

  async function speak(text: string): Promise<void> {
    stopPlayback();
    playbackToken += 1;
    const myToken = playbackToken;

    let entry = prefetchMap.get(text);
    if (!entry) {
      entry = fetchTts(text);
      prefetchMap.set(text, entry);
    }
    const { blob } = await entry;
    prefetchMap.delete(text);

    // Superseded while fetching (barge-in/close) — discard silently
    if (myToken !== playbackToken) return;

    const url = URL.createObjectURL(blob);
    currentUrl = url;
    return new Promise<void>((resolve, reject) => {
      const audio = new Audio(url);
      currentAudio = audio;
      const settle = (fn: () => void) => {
        pendingReject = null;
        fn();
      };
      audio.onended = () => { cleanup(); settle(resolve); };
      audio.onerror = () => { cleanup(); settle(() => reject(new Error("Audio playback failed"))); };
      pendingReject = (e) => { cleanup(); reject(e); };
      void audio.play().catch((e) => { cleanup(); settle(() => reject(e instanceof Error ? e : new Error("Audio play failed"))); });
    });
  }

  function stopPlayback() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.onended = null;
      currentAudio.onerror = null;
      currentAudio = null;
    }
    if (pendingReject) {
      const r = pendingReject;
      pendingReject = null;
      r(new Error("playback stopped"));
    }
    cleanup();
  }

  /** Full stop: aborts in-flight fetch + clears prefetch + stops playback. */
  function stop() {
    playbackToken += 1; // invalidate any awaited speak()
    fetchCtrl?.abort();
    fetchCtrl = null;
    prefetchMap.clear();
    stopPlayback();
  }

  function cleanup() {
    if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  }

  return { speak, prefetch, stop };
}

// ── Main session hook ─────────────────────────────────────────────────────────

export function useVoiceSession({
  instanceId,
  sttModel,
  ttsVoice,
  ttsProvider,
  voiceStyle,
  onSend,
  isAgentStreaming,
  latestAssistantText,
  latestAssistantMessageId,
  onOptimisticTranscript,
}: UseVoiceSessionOptions): UseVoiceSessionReturn {
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [state, setStateBase] = useState<VoiceSessionState>("IDLE");
  const [lastTranscription, setLastTranscription] = useState("");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [whisperAvailable, setWhisperAvailable] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Bug 1 fix: stateRef is the source of truth for async callbacks.
  const stateRef = useRef<VoiceSessionState>("IDLE");
  const setState = useCallback((s: VoiceSessionState) => {
    stateRef.current = s;
    setStateBase(s);
  }, []);

  const lastSpokenIdRef = useRef<string | null>(null);
  const isActiveRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // ── whisper-status: retry with backoff + refetch on focus (no silent dead mic)
  const whisperAvailableRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const check = () => {
      fetch("/api/whisper-status")
        .then((r) => r.json())
        .then((d: { available: boolean }) => {
          if (cancelled) return;
          whisperAvailableRef.current = d.available;
          setWhisperAvailable(d.available);
          if (d.available) { attempts = 0; setSessionError(null); }
        })
        .catch(() => {
          if (cancelled) return;
          whisperAvailableRef.current = false;
          setWhisperAvailable(false);
        })
        .finally(() => {
          if (!cancelled && !whisperAvailableRef.current && attempts < 3) {
            attempts += 1;
            setTimeout(check, 1000 * attempts);
          }
        });
    };
    check();
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; window.removeEventListener("focus", onFocus); };
  }, []);

  const { permissionState: micPermission, requestPermission: requestMicPermission, errorMessage: micError } = useMicPermission();

  const ttsCfgRef = useRef({ instanceId, ttsVoice, ttsProvider, voiceStyle });
  useEffect(() => { ttsCfgRef.current = { instanceId, ttsVoice, ttsProvider, voiceStyle }; }, [instanceId, ttsVoice, ttsProvider, voiceStyle]);
  const ttsRef = useRef<ReturnType<typeof createTts> | null>(null);
  if (!ttsRef.current) ttsRef.current = createTts(() => ttsCfgRef.current);
  const tts = ttsRef.current;

  // Cloud TTS ("fish-audio"/"openrouter") synthesizes the WHOLE response in one
  // request → one voice take per reply. Local-mac keeps sentence prefetch.
  const isCloudTtsRef = useRef(ttsProvider === "fish-audio" || ttsProvider === "openrouter");
  useEffect(() => { isCloudTtsRef.current = ttsProvider === "fish-audio" || ttsProvider === "openrouter"; }, [ttsProvider]);

  // ── Latency timing trace ──
  const timingRef = useRef<{ sttDone?: number; firstToken?: number; firstAudio?: boolean }>({});

  const startListeningRef = useRef<() => void>(() => {});

  const handleInterim = useCallback((text: string) => {
    if (!mountedRef.current || !isActiveRef.current) return;
    setLiveTranscript(text);
  }, []);

  const handleTranscribed = useCallback((text: string) => {
    if (!mountedRef.current || !isActiveRef.current) return;
    const trimmed = text.trim();
    setLiveTranscript("");
    if (!trimmed) {
      // empty transcript (silence abort) — re-arm listening
      setState("LISTENING");
      startListeningRef.current();
      return;
    }
    setLastTranscription(trimmed);
    timingRef.current.sttDone = performance.now();
    onOptimisticTranscript?.(trimmed);
    setState("THINKING");
    // decipher quickly: optimistic insert + immediate send (Claude is instant)
    onSend(trimmed);
  }, [onSend, onOptimisticTranscript, setState]);

  const sttIsLocal = !sttModel?.includes("/");
  const { volume, error: voiceError, startRecording, stopRecording } = useVoiceInput({
    onTranscribed: handleTranscribed,
    // Live interim transcript only for local STT (free, private; cloud would bill per tick)
    onInterim: sttIsLocal ? handleInterim : undefined,
    sttModel,
    instanceId,
    language: "en",
  });

  // TTS queue sentence-by-sentence
  const ttsQueueRef = useRef<string[]>([]);
  const speakingRef = useRef(false);
  const spokenUpToRef = useRef(0);

  const processQueue = useCallback(async () => {
    if (speakingRef.current) return;
    speakingRef.current = true;
    // Prefetch the first sentence immediately
    const first = ttsQueueRef.current[0];
    if (first) tts.prefetch(first);

    while (
      ttsQueueRef.current.length > 0 &&
      mountedRef.current &&
      isActiveRef.current &&
      stateRef.current === "SPEAKING" // Bug 1: read live state, not stale closure
    ) {
      const sentence = ttsQueueRef.current.shift()!;
      const next = ttsQueueRef.current[0];
      if (next) tts.prefetch(next); // overlap fetch(N+1) with playback(N)
      try {
        if (!timingRef.current.firstAudio) {
          timingRef.current.firstAudio = true;
          const t = timingRef.current;
          if (t.sttDone !== undefined && t.firstToken !== undefined) {
            console.debug("[voice-timing]", {
              stt_done: Math.round(t.sttDone),
              first_token: Math.round(t.firstToken - t.sttDone),
              first_audio: Math.round(performance.now() - t.sttDone),
            });
          }
        }
        await tts.speak(sentence);
      } catch { /* aborted or failed — skip; next iteration re-checks state */ }
    }
    speakingRef.current = false;

    // Auto-loop back to listening ONLY if nothing interrupted us
    if (
      mountedRef.current &&
      isActiveRef.current &&
      stateRef.current === "SPEAKING" && // Bug 1: live check — barge-in already re-armed
      ttsQueueRef.current.length === 0
    ) {
      setState("LISTENING");
      startListeningRef.current();
    }
  }, [tts, setState]);

  // ── Feed streamed assistant text to TTS ──
  useEffect(() => {
    if (!isVoiceActive || !latestAssistantText) return;
    if (state !== "SPEAKING" && state !== "THINKING") return;

    if (latestAssistantMessageId && latestAssistantMessageId !== lastSpokenIdRef.current) {
      lastSpokenIdRef.current = latestAssistantMessageId;
      spokenUpToRef.current = 0;
      ttsQueueRef.current = [];
      speakingRef.current = false;
    }

    const newText = latestAssistantText.slice(spokenUpToRef.current);
    if (!newText) return;

    const enqueueAndSpeak = (items: string[], consumedLen: number) => {
      // Guaranteed-speakable: strip markdown/symbols before TTS — flash models
      // ignore the prompt sometimes, TTS must never read formatting aloud.
      ttsQueueRef.current.push(...items.map((s) => toSpeakable(s)).filter(Boolean));
      spokenUpToRef.current += consumedLen;
      setState("SPEAKING");
      void processQueue();
    };

    if (isCloudTtsRef.current) {
      // Cloud = ONE synthesis per response (single voice take). Speak when the
      // stream completes; split only very long replies at paragraph boundaries.
      if (!isAgentStreaming) {
        const full = latestAssistantText.trim();
        if (!full) return;
        const chunks: string[] = [];
        if (full.length <= 4500) {
          chunks.push(full);
        } else {
          let cur = "";
          for (const para of full.split(/\n{2,}/)) {
            if (cur && (cur + "\n\n" + para).length > 4500) { chunks.push(cur); cur = para; }
            else cur = cur ? cur + "\n\n" + para : para;
          }
          if (cur.trim()) chunks.push(cur);
        }
        enqueueAndSpeak(chunks, latestAssistantText.length);
      }
      // Still streaming → stay THINKING; the bar shows "Thinking…"
      return;
    }

    // Local-mac: sentence-by-sentence with prefetch
    const sentenceRegex = /[^.!?\n]+[.!?\n]+/g;
    const sentences: string[] = [];
    let consumed = 0; // Bug 3: advance by lastIndex of untrimmed matches
    let m: RegExpExecArray | null;
    while ((m = sentenceRegex.exec(newText)) !== null) {
      sentences.push(m[0].trim()); // trim only the TTS payload
      consumed = sentenceRegex.lastIndex;
    }

    if (sentences.length > 0) {
      enqueueAndSpeak(sentences, consumed);
    }

    // Flush non-sentence tail when the agent finished streaming
    if (!isAgentStreaming) {
      const remaining = latestAssistantText.slice(spokenUpToRef.current);
      if (remaining.trim()) {
        enqueueAndSpeak([remaining.trim()], latestAssistantText.length - spokenUpToRef.current);
      }
    }
  }, [latestAssistantText, latestAssistantMessageId, isVoiceActive, state, isAgentStreaming, processQueue, setState]);

  // THINKING → SPEAKING is driven by the queue above; track first token for timing
  useEffect(() => {
    if (isAgentStreaming && !timingRef.current.firstToken) {
      timingRef.current.firstToken = performance.now();
    }
  }, [isAgentStreaming]);

  const startListening = useCallback(() => {
    if (!mountedRef.current || !isActiveRef.current) return;
    setState("LISTENING");
    void startRecording();
  }, [startRecording, setState]);

  // Keep a ref so callbacks declared before startListening can call it safely
  useEffect(() => { startListeningRef.current = startListening; }, [startListening]);

  const openVoice = useCallback(() => {
    if (!whisperAvailableRef.current) {
      // No silent no-op — surface why the mic won't start
      setSessionError(
        "Whisper server unreachable. Start the local STT server (WHISPER_BASE_URL) or pick an OpenRouter STT model in Settings → Voice.",
      );
      return;
    }
    setSessionError(null);
    isActiveRef.current = true;
    setIsVoiceActive(true);
    lastSpokenIdRef.current = latestAssistantMessageId ?? null;
    spokenUpToRef.current = latestAssistantText ? latestAssistantText.length : 0;
    ttsQueueRef.current = [];
    speakingRef.current = false;
    timingRef.current = {};
    setLastTranscription("");
    setLiveTranscript("");
    setState("IDLE");
    if (micPermission === "granted") startListening();
  }, [micPermission, startListening, latestAssistantMessageId, latestAssistantText, setState]);

  const stopAll = useCallback(() => {
    stopRecording();
    tts.stop(); // aborts in-flight fetch + prefetches (per-utterance, no sticky flag)
    ttsQueueRef.current = [];
    speakingRef.current = false;
  }, [stopRecording, tts]);

  const closeVoice = useCallback(() => {
    isActiveRef.current = false;
    stopAll();
    setState("IDLE");
    setIsVoiceActive(false);
    setLastTranscription("");
    setLiveTranscript("");
    spokenUpToRef.current = 0;
    lastSpokenIdRef.current = null;
  }, [stopAll, setState]);

  // ── Barge-in: sustained mic energy during SPEAKING (Bug 5 tuned) ──
  const BARGE_VOLUME = 55;    // ≈ rms 0.069 — speech-level, not TTS bleed
  const BARGE_POLLS = 9;      // 9 × 33ms ≈ 300ms sustained
  const bargeCountRef = useRef(0);
  useEffect(() => {
    if (!isVoiceActive || stateRef.current !== "SPEAKING") {
      bargeCountRef.current = 0;
      return;
    }
    if (volume > BARGE_VOLUME) {
      bargeCountRef.current += 1;
      if (bargeCountRef.current >= BARGE_POLLS) {
        bargeCountRef.current = 0;
        stopAll();
        // stateRef set synchronously so processQueue's tail check won't auto-loop
        startListening();
      }
    } else {
      bargeCountRef.current = 0;
    }
  }, [volume, isVoiceActive, stopAll, startListening]);

  useEffect(() => () => { isActiveRef.current = false; stopAll(); }, [stopAll]);

  return {
    isVoiceActive,
    state,
    micPermission,
    volume,
    lastTranscription,
    liveTranscript,
    voiceError: sessionError || voiceError || micError,
    whisperAvailable,
    openVoice,
    closeVoice,
    stopAll,
    requestMicPermission: async () => {
      const granted = await requestMicPermission();
      if (granted) startListening();
      return granted;
    },
  };
}
