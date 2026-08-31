/**
 * @deprecated Old ScriptProcessorNode capture (fixed 4096). Kept for reference.
 * New capture is use-voice-capture.ts (AudioWorklet, 16kHz, lower latency).
 * This file remains functional for transcribe via /api/transcribe with sttModel/instanceId
 * overrides, but new code should prefer use-voice-session.
 */
"use client";

import { useState, useRef, useCallback, useEffect } from "react";

export type VoiceInputState =
  | "idle"
  | "requesting-permission"
  | "recording"
  | "transcribing"
  | "error";

interface UseVoiceInputOptions {
  /** Called with the final transcribed text once Whisper responds. */
  onTranscribed: (text: string) => void;
  /** Called periodically with growing interim text while still recording (local STT only). */
  onInterim?: (text: string) => void;
  /** Silence duration in ms before auto-stop. Default: 1000ms */
  silenceDurationMs?: number;
  /** Max recording duration in ms (safety cap). Default: 60000ms */
  maxDurationMs?: number;
  /** STT model override (small default, v1 local-only) */
  sttModel?: string;
  /** Instance id for per-project model resolution fallback */
  instanceId?: string;
  /** Language hint for Whisper */
  language?: string;
}

interface UseVoiceInputReturn {
  state: VoiceInputState;
  /** Real-time volume level 0–100, updated ~30fps while recording. */
  volume: number;
  error: string | null;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
}

// ── VAD tuning (Bug 4 fix: hysteresis + grace + min-utterance) ──────────────
// Enter threshold higher than exit (hysteresis) so noisy mics don't flicker;
// silence timer starts unconditionally after GRACE_MS so a quiet mic that never
// trips ENTER still ends the recording instead of running to maxDuration.
const RMS_ENTER_THRESHOLD = 0.015;  // speech starts above this
const RMS_EXIT_THRESHOLD = 0.008;   // speech counts as ongoing while above this
const NO_SPEECH_ABORT_MS = 2500;    // pure silence after grace → abort recording
const GRACE_MS = 1500;              // before NO_SPEECH_ABORT kicks in
const MIN_UTTERANCE_MS = 400;       // never auto-stop before this (guards taps)
const VOLUME_POLL_INTERVAL_MS = 33; // ~30fps

// ── Downsample to 16 kHz (Whisper-native) before upload — ~3× fewer bytes ───
function downsampleTo16k(buffers: Float32Array[], sampleRate: number): { buffers: Float32Array[]; sampleRate: number } {
  if (sampleRate === 16000) return { buffers, sampleRate };
  const ratio = sampleRate / 16000;
  const out: Float32Array[] = [];
  // Carry the last sample across buffer boundaries so no edge sample is dropped
  let prevTail: Float32Array = new Float32Array(0);
  for (const buf of buffers) {
    const joined = prevTail.length > 0 ? (() => { const j = new Float32Array(prevTail.length + buf.length); j.set(prevTail); j.set(buf, prevTail.length); return j; })() : buf;
    const outLen = Math.floor(joined.length / ratio);
    const res = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = i * ratio;
      const i0 = Math.floor(idx);
      const frac = idx - i0;
      const s0 = joined[i0] ?? 0;
      const s1 = joined[i0 + 1] ?? s0;
      res[i] = s0 + (s1 - s0) * frac;
    }
    out.push(res);
    const consumed = Math.floor(joined.length / ratio) * ratio;
    prevTail = joined.slice(consumed);
  }
  return { buffers: out, sampleRate: 16000 };
}

// ── WAV Encoder ─────────────────────────────────────────────────────────────
function bufferToWav(
  pcmBuffers: Float32Array[],
  sampleRate: number,
): Blob {
  const totalLength = pcmBuffers.reduce((s, b) => s + b.length, 0);
  const numOfChan = 1; // mono
  const bitDepth = 16;
  const byteRate = sampleRate * numOfChan * (bitDepth / 8);
  const blockAlign = numOfChan * (bitDepth / 8);
  const dataByteLen = totalLength * (bitDepth / 8);
  const arrayBuffer = new ArrayBuffer(44 + dataByteLen);
  const view = new DataView(arrayBuffer);

  let pos = 0;
  const str = (s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(pos++, s.charCodeAt(i)); };
  const u32 = (v: number) => { view.setUint32(pos, v, true); pos += 4; };
  const u16 = (v: number) => { view.setUint16(pos, v, true); pos += 2; };

  str("RIFF");   u32(36 + dataByteLen);
  str("WAVE");
  str("fmt ");   u32(16);
  u16(1);        // PCM format
  u16(numOfChan);
  u32(sampleRate);
  u32(byteRate);
  u16(blockAlign);
  u16(bitDepth);
  str("data");   u32(dataByteLen);

  // Write interleaved PCM samples
  let offset = pos;
  for (const buf of pcmBuffers) {
    for (let i = 0; i < buf.length; i++) {
      const s = Math.max(-1, Math.min(1, buf[i]!));
      const pcm = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(offset, pcm, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

export function useVoiceInput({
  onTranscribed,
  onInterim,
  silenceDurationMs = 1000,
  maxDurationMs = 60_000,
  sttModel,
  instanceId,
  language,
}: UseVoiceInputOptions): UseVoiceInputReturn {
  const [state, setState] = useState<VoiceInputState>("idle");
  const [volume, setVolume] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // ── Stable refs — avoids ALL stale closure bugs ──────────────────────────
  const onTranscribedRef = useRef(onTranscribed);
  const onInterimRef = useRef(onInterim);
  const silenceDurationMsRef = useRef(silenceDurationMs);
  const maxDurationMsRef = useRef(maxDurationMs);
  const sttModelRef = useRef(sttModel);
  const instanceIdRef = useRef(instanceId);
  const languageRef = useRef(language);
  useEffect(() => { onTranscribedRef.current = onTranscribed; }, [onTranscribed]);
  useEffect(() => { onInterimRef.current = onInterim; }, [onInterim]);
  useEffect(() => { silenceDurationMsRef.current = silenceDurationMs; }, [silenceDurationMs]);
  useEffect(() => { maxDurationMsRef.current = maxDurationMs; }, [maxDurationMs]);
  useEffect(() => { sttModelRef.current = sttModel; }, [sttModel]);
  useEffect(() => { instanceIdRef.current = instanceId; }, [instanceId]);
  useEffect(() => { languageRef.current = language; }, [language]);

  // ── Audio node refs ──────────────────────────────────────────────────────
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recordingBuffersRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef(44100);

  // ── Timer refs ───────────────────────────────────────────────────────────
  const volumePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceCounterRef = useRef(0);
  const hasAudioRef = useRef(false);
  const recordingStartRef = useRef(0);

  // ── Interim (live) transcription refs ────────────────────────────────────
  const interimTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const interimBusyRef = useRef(false);
  const interimAbortRef = useRef<AbortController | null>(null);
  const interimCancelledRef = useRef(false);
  const lastInterimSamplesRef = useRef(0);

  // ── State machine ref — the SOURCE OF TRUTH for callbacks ────────────────
  // Using a ref so setInterval / setTimeout callbacks always read current state
  // without needing to be recreated (which causes stale closures).
  const isRecordingRef = useRef(false);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // ── Core teardown (stable — no deps needed) ──────────────────────────────
  const clearTimers = useCallback(() => {
    if (volumePollRef.current) { clearInterval(volumePollRef.current); volumePollRef.current = null; }
    if (maxDurationTimerRef.current) { clearTimeout(maxDurationTimerRef.current); maxDurationTimerRef.current = null; }
    if (interimTimerRef.current) { clearInterval(interimTimerRef.current); interimTimerRef.current = null; }
  }, []);

  const releaseAudio = useCallback(() => {
    try {
      scriptProcessorRef.current?.disconnect();
      if (scriptProcessorRef.current) scriptProcessorRef.current.onaudioprocess = null;
    } catch { /* ignore */ }
    try { sourceRef.current?.disconnect(); } catch { /* ignore */ }
    try { analyserRef.current?.disconnect(); } catch { /* ignore */ }
    try { void audioCtxRef.current?.close(); } catch { /* ignore */ }
    streamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });

    scriptProcessorRef.current = null;
    sourceRef.current = null;
    analyserRef.current = null;
    audioCtxRef.current = null;
    streamRef.current = null;
  }, []);

  // ── Transcription — AbortController + request-id guard (no duplicate sends) ─
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const transcribeReqIdRef = useRef(0);

  const doTranscribe = useCallback((buffers: Float32Array[], sampleRate: number) => {
    if (!isMountedRef.current) return;
    if (buffers.length === 0) {
      setState("idle");
      setVolume(0);
      return;
    }

    setState("transcribing");
    setVolume(0);

    // Downsample to 16 kHz before encoding — smaller upload, same accuracy
    const ds = downsampleTo16k(buffers, sampleRate);
    const wavBlob = bufferToWav(ds.buffers, ds.sampleRate);
    const form = new FormData();
    form.append("audio", wavBlob, "recording.wav");
    if (sttModelRef.current) form.append("model", sttModelRef.current);
    if (instanceIdRef.current) form.append("instanceId", instanceIdRef.current);
    if (languageRef.current) form.append("language", languageRef.current);

    // Abort any in-flight transcription; only the latest request may resolve
    transcribeAbortRef.current?.abort();
    const ctrl = new AbortController();
    transcribeAbortRef.current = ctrl;
    const reqId = ++transcribeReqIdRef.current;
    const t0 = performance.now();

    fetch("/api/transcribe", { method: "POST", body: form, signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json() as { error?: string };
          throw new Error(body.error ?? "Transcription failed");
        }
        return res.json() as Promise<{ text: string }>;
      })
      .then(({ text }) => {
        // Guard: a superseded request must never fire onTranscribed (dup turns)
        if (reqId !== transcribeReqIdRef.current || !isMountedRef.current) return;
        console.debug("[voice-timing] stt_done_ms", Math.round(performance.now() - t0));
        setState("idle");
        const trimmed = text.trim();
        if (trimmed) onTranscribedRef.current(trimmed);
        else {
          // empty transcript (pure silence) — back to idle; session re-arms listening
          setState("idle");
        }
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return; // superseded
        if (!isMountedRef.current) return;
        setState("error");
        setError(err instanceof Error ? err.message : "Transcription failed");
      });
  }, []);

  // ── Interim (live) transcription tick ────────────────────────────────────
  // Every ~1.2s while speech has been detected, re-run Whisper on the audio
  // so-far and surface growing text. Sequential (one in-flight max), local
  // STT only — cloud STT would bill per tick.
  const INTERIM_INTERVAL_MS = 1200;
  const INTERIM_MIN_NEW_SAMPLES = 8000; // ~0.5s @16kHz of new audio per tick

  const runInterimTick = useCallback(() => {
    if (!isRecordingRef.current || interimBusyRef.current) return;
    if (!onInterimRef.current) return;
    if (!hasAudioRef.current) return; // no speech yet — nothing to show

    const totalSamples = recordingBuffersRef.current.reduce((s, b) => s + b.length, 0);
    if (totalSamples - lastInterimSamplesRef.current < INTERIM_MIN_NEW_SAMPLES) return;

    interimBusyRef.current = true;
    const snapshot = [...recordingBuffersRef.current];
    const rate = sampleRateRef.current;
    lastInterimSamplesRef.current = totalSamples;

    const ds = downsampleTo16k(snapshot, rate);
    const wavBlob = bufferToWav(ds.buffers, ds.sampleRate);
    const form = new FormData();
    form.append("audio", wavBlob, "interim.wav");
    if (sttModelRef.current) form.append("model", sttModelRef.current);
    if (instanceIdRef.current) form.append("instanceId", instanceIdRef.current);
    if (languageRef.current) form.append("language", languageRef.current);

    interimAbortRef.current?.abort();
    const ctrl = new AbortController();
    interimAbortRef.current = ctrl;

    fetch("/api/transcribe", { method: "POST", body: form, signal: ctrl.signal })
      .then(async (res) => (res.ok ? (res.json() as Promise<{ text: string }>) : Promise.reject(new Error("interim failed"))))
      .then(({ text }) => {
        if (interimCancelledRef.current || !isRecordingRef.current) return; // superseded by final
        const trimmed = text.trim();
        if (trimmed) onInterimRef.current?.(trimmed);
      })
      .catch(() => { /* interim is best-effort — final pass is authoritative */ })
      .finally(() => {
        interimBusyRef.current = false;
        if (interimAbortRef.current === ctrl) interimAbortRef.current = null;
      });
  }, []);

  // ── stopRecording — stable, reads state from ref ──────────────────────────
  const stopRecording = useCallback(() => {
    if (!isRecordingRef.current) return; // idempotent
    isRecordingRef.current = false;

    // Drop any in-flight interim result — the final pass is authoritative
    interimCancelledRef.current = true;
    interimAbortRef.current?.abort();

    clearTimers();

    // Snapshot buffers & sample rate BEFORE releasing audio nodes
    const buffers = [...recordingBuffersRef.current];
    const sampleRate = sampleRateRef.current;
    recordingBuffersRef.current = [];

    releaseAudio();

    if (isMountedRef.current) {
      doTranscribe(buffers, sampleRate);
    }
  }, [clearTimers, releaseAudio, doTranscribe]);

  // ── startRecording ────────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    if (isRecordingRef.current) return; // already recording

    setError(null);
    setState("requesting-permission");
    recordingBuffersRef.current = [];
    hasAudioRef.current = false;
    silenceCounterRef.current = 0;
    recordingStartRef.current = Date.now();
    // reset interim state for a fresh utterance
    interimCancelledRef.current = false;
    interimBusyRef.current = false;
    lastInterimSamplesRef.current = 0;

    let stream: MediaStream;
    try {
      // Explicit constraints: AEC prevents barge-in on Jarvis's own TTS (Bug 5),
      // NS + AGC stabilize RMS so the silence timer is meaningful on laptop mics.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      setState("error");
      setError(err instanceof Error ? err.message : "Microphone permission denied.");
      return;
    }

    if (!isMountedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    streamRef.current = stream;

    // AudioContext
    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;
    sampleRateRef.current = audioCtx.sampleRate;

    const source = audioCtx.createMediaStreamSource(stream);
    sourceRef.current = source;

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.4;
    analyserRef.current = analyser;

    // ScriptProcessor for raw PCM capture (deprecated API but stable; output is
    // silence by design — connect through a zero-gain node for hygiene)
    const scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
    scriptProcessorRef.current = scriptProcessor;
    scriptProcessor.onaudioprocess = (e) => {
      if (!isRecordingRef.current) return;
      const input = e.inputBuffer.getChannelData(0);
      recordingBuffersRef.current.push(new Float32Array(input));
    };

    const zeroGain = audioCtx.createGain();
    zeroGain.gain.value = 0;
    source.connect(analyser);
    source.connect(scriptProcessor);
    scriptProcessor.connect(zeroGain);
    zeroGain.connect(audioCtx.destination); // required for onaudioprocess, emits silence

    isRecordingRef.current = true;
    setState("recording");

    const dataArray = new Float32Array(analyser.fftSize);
    const recStart = recordingStartRef.current;

    // ── Volume polling + VAD silence detection (hysteresis + grace) ──
    volumePollRef.current = setInterval(() => {
      if (!isRecordingRef.current || !analyserRef.current) return;

      analyserRef.current.getFloatTimeDomainData(dataArray);

      let sumSq = 0;
      for (const s of dataArray) sumSq += s * s;
      const rms = Math.sqrt(sumSq / dataArray.length);
      const scaledVolume = Math.min(100, Math.round(rms * 800));

      if (isMountedRef.current) setVolume(scaledVolume);

      // Hysteresis: enter on RMS_ENTER, stay in speech until below RMS_EXIT
      const inSpeech = hasAudioRef.current ? rms > RMS_EXIT_THRESHOLD : rms > RMS_ENTER_THRESHOLD;
      const elapsed = Date.now() - recStart;

      if (inSpeech) {
        hasAudioRef.current = true;
        silenceCounterRef.current = 0;
      } else if (hasAudioRef.current) {
        // speech was seen — normal silence timeout, but never before MIN_UTTERANCE
        silenceCounterRef.current += VOLUME_POLL_INTERVAL_MS;
        if (
          silenceCounterRef.current >= silenceDurationMsRef.current &&
          elapsed >= MIN_UTTERANCE_MS
        ) {
          stopRecording();
        }
      } else if (elapsed > GRACE_MS) {
        // never saw speech — abort after NO_SPEECH_ABORT so a quiet mic that
        // never trips ENTER doesn't hold the recording to the 60s cap (Bug 4)
        silenceCounterRef.current += VOLUME_POLL_INTERVAL_MS;
        if (silenceCounterRef.current >= NO_SPEECH_ABORT_MS) {
          stopRecording();
        }
      }
    }, VOLUME_POLL_INTERVAL_MS);

    // ── Safety max-duration cap ──
    maxDurationTimerRef.current = setTimeout(() => {
      stopRecording();
    }, maxDurationMsRef.current);

    // ── Interim (live) transcript ticks — only when a callback is wired ──
    if (onInterimRef.current) {
      interimTimerRef.current = setInterval(runInterimTick, INTERIM_INTERVAL_MS);
    }
  }, [stopRecording, runInterimTick]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      isRecordingRef.current = false;
      clearTimers();
      releaseAudio();
      recordingBuffersRef.current = [];
      transcribeAbortRef.current?.abort();
      interimCancelledRef.current = true;
      interimAbortRef.current?.abort();
    };
  }, [clearTimers, releaseAudio]);

  return { state, volume, error, startRecording, stopRecording };
}
