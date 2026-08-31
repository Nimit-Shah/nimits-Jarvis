/**
 * @deprecated Old hook wired to full-screen overlay (IDLE→SPEAKING_GREETING→LISTENING→PROCESSING→SPEAKING_RESPONSE→IDLE).
 * Kept per request — commented/deprecated. New Claude-exact session is use-voice-session.ts:
 * auto-loop Listening→Speaking→Listening, barge-in, optimistic pill, streaming opacity
 * (see frame_045.jpg:1, frame_100.jpg:1). Do not extend this file.
 */
"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useVoiceInput } from "./use-voice-input";
import { useMicPermission } from "./use-mic-permission";
import type { MicPermissionState } from "./use-mic-permission";

// ── State Machine ──────────────────────────────────────────────────────────────
//
//  IDLE → SPEAKING_GREETING → LISTENING → PROCESSING → SPEAKING_RESPONSE → IDLE
//                                                               ↑
//  (overlay stays open so user can ask follow-up questions)
//

export type JarvisVoiceState =
  | "IDLE"
  | "SPEAKING_GREETING"
  | "LISTENING"
  | "PROCESSING"
  | "SPEAKING_RESPONSE";

interface UseJarvisVoiceOptions {
  onSend: (text: string) => void;
  isAgentStreaming: boolean;
  latestAssistantText?: string;
  latestAssistantMessageId?: string;
  instanceId?: string;
  sttModel?: string;
  ttsVoice?: string;
  ttsProvider?: string;
}

interface UseJarvisVoiceReturn {
  isVoiceModeOpen: boolean;
  jarvisState: JarvisVoiceState;
  micPermission: MicPermissionState;
  volume: number;
  lastTranscription: string;
  voiceError: string | null;
  whisperAvailable: boolean;
  openVoiceMode: () => void;
  closeVoiceMode: () => void;
  requestMicPermission: () => Promise<boolean>;
}

// ── Provider-aware TTS via /api/tts (fish-audio default, local-mac fallback) ─────

function createMacTTS(getVoiceConfig?: () => { voice?: string; provider?: string; instanceId?: string }) {
  let currentAudio: HTMLAudioElement | null = null;
  let currentUrl: string | null = null;

  async function speak(text: string): Promise<void> {
    stop(); // cancel any ongoing playback
    const cfg = getVoiceConfig?.() ?? {};
    const instanceQs = cfg.instanceId ? `?instanceId=${encodeURIComponent(cfg.instanceId)}` : "";

    const res = await fetch(`/api/tts${instanceQs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: cfg.voice, provider: cfg.provider }),
    });

    if (!res.ok) {
      throw new Error("TTS generation failed");
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    currentUrl = url;

    return new Promise<void>((resolve, reject) => {
      const audio = new Audio(url);
      currentAudio = audio;

      audio.onended = () => {
        cleanup();
        resolve();
      };
      audio.onerror = () => {
        cleanup();
        reject(new Error("Audio playback failed"));
      };

      void audio.play().catch((err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error("Audio play failed"));
      });
    });
  }

  function stop() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.onended = null;
      currentAudio.onerror = null;
      currentAudio = null;
    }
    cleanup();
  }

  function cleanup() {
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
      currentUrl = null;
    }
  }

  return { speak, stop };
}

// ── Main Hook ──────────────────────────────────────────────────────────────────

const GREETING_TEXT = "What can I do for you?";

export function useJarvisVoice({
  onSend,
  isAgentStreaming,
  latestAssistantText,
  latestAssistantMessageId,
  instanceId,
  sttModel,
  ttsVoice,
  ttsProvider,
}: UseJarvisVoiceOptions): UseJarvisVoiceReturn {
  const [isVoiceModeOpen, setIsVoiceModeOpen] = useState(false);
  const [jarvisState, setJarvisState] = useState<JarvisVoiceState>("IDLE");
  const [lastTranscription, setLastTranscription] = useState("");
  const [whisperAvailable, setWhisperAvailable] = useState(false);
  const lastSpokenMessageIdRef = useRef<string | null>(null);
  // Mutable ref so TTS queue loop can check without stale closure issues
  const isVoiceModeOpenRef = useRef(false);

  const { permissionState: micPermission, requestPermission: requestMicPermission, errorMessage: micErrorMessage } =
    useMicPermission();

  // Refs for voice config to avoid recreating TTS on every prop change
  const ttsConfigRef = useRef({ instanceId, ttsVoice, ttsProvider });
  useEffect(() => { ttsConfigRef.current = { instanceId, ttsVoice, ttsProvider }; }, [instanceId, ttsVoice, ttsProvider]);

  // Stable TTS instance
  const ttsRef = useRef<ReturnType<typeof createMacTTS> | null>(null);
  if (!ttsRef.current) ttsRef.current = createMacTTS(() => ttsConfigRef.current);
  const tts = ttsRef.current;

  // Track whether the component is still mounted
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Whisper server health check on mount ──
  useEffect(() => {
    void fetch("/api/whisper-status")
      .then((r) => r.json())
      .then((data: { available: boolean }) => setWhisperAvailable(data.available))
      .catch(() => setWhisperAvailable(false));
  }, []);

  // ── Transcription callback → auto-send → wait for agent response ──
  const handleTranscribed = useCallback(
    (text: string) => {
      if (!mountedRef.current) return;
      setLastTranscription(text);
      setJarvisState("PROCESSING");
      // Auto-send after a brief flash so the user sees the transcription
      setTimeout(() => {
        onSend(text);
      }, 300);
    },
    [onSend],
  );

  const { state: voiceInputState, volume, error: voiceError, startRecording, stopRecording } =
    useVoiceInput({ onTranscribed: handleTranscribed, sttModel, instanceId });

  // ── TTS: speak the agent's response sentence-by-sentence ──
  const spokenUpToRef = useRef(0);
  const ttsQueueRef = useRef<string[]>([]);
  const isSpeakingLoopActiveRef = useRef(false);

  const processQueue = useCallback(async () => {
    if (isSpeakingLoopActiveRef.current) return;
    isSpeakingLoopActiveRef.current = true;

    while (ttsQueueRef.current.length > 0 && mountedRef.current && isVoiceModeOpenRef.current) {
      const sentence = ttsQueueRef.current.shift()!;
      try {
        await tts.speak(sentence);
      } catch {
        // TTS failed — skip this sentence, continue
      }
    }

    isSpeakingLoopActiveRef.current = false;
    ttsQueueRef.current = [];
    // If we're still in SPEAKING_RESPONSE and queue is empty, return to IDLE
    if (mountedRef.current && isVoiceModeOpenRef.current) {
      setJarvisState((prev) => (prev === "SPEAKING_RESPONSE" ? "IDLE" : prev));
    }
  }, [tts]);

  // Feed new assistant text to TTS as it streams
  useEffect(() => {
    if (!isVoiceModeOpen || !latestAssistantText || jarvisState === "IDLE") return;

    // If the message ID has changed, it means a new message stream has started
    if (latestAssistantMessageId && latestAssistantMessageId !== lastSpokenMessageIdRef.current) {
      lastSpokenMessageIdRef.current = latestAssistantMessageId;
      spokenUpToRef.current = 0;
      ttsQueueRef.current = [];
    }

    // If we're looking at the ignored initial message and haven't typed a new query yet, don't read it
    if (latestAssistantMessageId === lastSpokenMessageIdRef.current && spokenUpToRef.current >= latestAssistantText.length) {
      return;
    }

    const newText = latestAssistantText.slice(spokenUpToRef.current);
    if (!newText) return;

    // Split by sentence boundaries
    const sentenceRegex = /[^.!?\n]+[.!?\n]+/g;
    const sentences: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = sentenceRegex.exec(newText)) !== null) {
      sentences.push(match[0].trim());
    }

    if (sentences.length > 0) {
      spokenUpToRef.current += sentences.join("").length;
      ttsQueueRef.current.push(...sentences);

      setJarvisState("SPEAKING_RESPONSE");
      void processQueue();
    }
  }, [latestAssistantText, latestAssistantMessageId, isVoiceModeOpen, jarvisState, processQueue]);

  // ── Voice Mode lifecycle ──

  const runVoiceLoop = useCallback(async () => {
    if (!mountedRef.current || !isVoiceModeOpenRef.current) return;

    // Phase 1: Speak greeting
    setJarvisState("SPEAKING_GREETING");
    try {
      await tts.speak(GREETING_TEXT);
    } catch {
      // TTS failed — proceed to listening anyway
    }

    if (!mountedRef.current || !isVoiceModeOpenRef.current) return;

    // Phase 2: Start listening
    setJarvisState("LISTENING");
    await startRecording();
    // Recording continues until VAD silence detection stops it → handleTranscribed fires
  }, [tts, startRecording]);

  const openVoiceMode = useCallback(() => {
    if (!whisperAvailable) return;
    isVoiceModeOpenRef.current = true;
    lastSpokenMessageIdRef.current = latestAssistantMessageId || null;
    spokenUpToRef.current = latestAssistantText ? latestAssistantText.length : 0;
    ttsQueueRef.current = [];
    isSpeakingLoopActiveRef.current = false;
    setLastTranscription("");
    setJarvisState("IDLE");
    setIsVoiceModeOpen(true);

    if (micPermission === "granted") {
      void runVoiceLoop();
    }
  }, [whisperAvailable, micPermission, runVoiceLoop, latestAssistantMessageId, latestAssistantText]);

  const closeVoiceMode = useCallback(() => {
    isVoiceModeOpenRef.current = false;
    stopRecording();
    tts.stop();
    ttsQueueRef.current = [];
    isSpeakingLoopActiveRef.current = false;
    setJarvisState("IDLE");
    setIsVoiceModeOpen(false);
    setLastTranscription("");
    spokenUpToRef.current = 0;
    lastSpokenMessageIdRef.current = null;
  }, [stopRecording, tts]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      isVoiceModeOpenRef.current = false;
      stopRecording();
      tts.stop();
      ttsQueueRef.current = [];
      isSpeakingLoopActiveRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expose runVoiceLoop for the overlay to call after permission is granted
  const startAfterPermission = useCallback(() => {
    void runVoiceLoop();
  }, [runVoiceLoop]);

  // When agent finishes streaming and we haven't spoken the remaining text yet
  useEffect(() => {
    if (!isAgentStreaming && jarvisState === "PROCESSING" && latestAssistantText) {
      // Agent finished — flush any remaining text to TTS
      const remaining = latestAssistantText.slice(spokenUpToRef.current);
      if (remaining.trim()) {
        spokenUpToRef.current = latestAssistantText.length;
        ttsQueueRef.current.push(remaining.trim());
        setJarvisState("SPEAKING_RESPONSE");
        void processQueue();
      }
    }
  }, [isAgentStreaming, jarvisState, latestAssistantText, processQueue]);

  return {
    isVoiceModeOpen,
    jarvisState,
    micPermission,
    volume,
    lastTranscription,
    voiceError: voiceError || micErrorMessage,
    whisperAvailable,
    openVoiceMode,
    closeVoiceMode,
    requestMicPermission: async () => {
      const granted = await requestMicPermission();
      if (granted) startAfterPermission();
      return granted;
    },
  };
}
