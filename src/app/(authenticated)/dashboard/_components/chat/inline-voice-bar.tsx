"use client";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import type { VoiceSessionState } from "./use-voice-session";

interface InlineVoiceBarProps {
  state: VoiceSessionState;
  volume: number; // 0-100
  /** Growing interim transcription while the user is still speaking */
  liveTranscript?: string;
  error?: string | null;
  /** Single control: full stop — cancels LLM + TTS + mic and exits to text mode */
  onStop: () => void;
}

/**
 * Claude-exact inline voice bar (docked, history stays visible).
 * Minimal controls: state placeholder (with live transcript) + Stop.
 * Stop ends the turn AND returns to text mode.
 */
export function InlineVoiceBar({ state, volume, liveTranscript, error, onStop }: InlineVoiceBarProps) {
  const isListening = state === "LISTENING" || state === "TRANSCRIBING";
  const isSpeaking = state === "SPEAKING";
  const isThinking = state === "THINKING";
  const isActive = isListening || isSpeaking || isThinking;

  const placeholder = isSpeaking
    ? "Jarvis is speaking…"
    : isThinking
      ? "Thinking…"
      : isListening
        ? "Listening…"
        : "Voice ready…";

  // Glow intensity from volume (Claude bottom glow)
  const glowOpacity = isActive ? 0.12 + (volume / 100) * 0.18 : 0;

  return (
    <div className="relative border-t border-border/50 bg-background p-3 md:p-4">
      {/* Bottom glow — Claude orange */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-28 transition-opacity"
        style={{
          background: `radial-gradient(ellipse 60% 80% at 50% 100%, rgba(249,115,22,${glowOpacity}) 0%, transparent 70%)`,
          filter: "blur(18px)",
        }}
        aria-hidden
      />

      <div className="relative mx-auto flex max-w-3xl flex-col gap-2">
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
        )}

        <div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-muted/20 px-3 py-2.5 shadow-sm">
          {/* Center: live transcript grows here while speaking; otherwise state placeholder */}
          <div className="min-w-0 flex-1">
            {isListening && liveTranscript ? (
              <p className="truncate text-sm text-foreground">
                {liveTranscript}
                <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-orange-500 align-middle" aria-hidden />
              </p>
            ) : (
              <div className="flex items-center gap-2">
                <span className={cn("text-sm", isListening ? "text-foreground" : "text-muted-foreground")}>
                  {placeholder}
                </span>
                {isListening && (
                  <div className="flex items-center gap-0.5" aria-hidden>
                    {Array.from({ length: 5 }).map((_, i) => (
                      <span
                        key={i}
                        className="inline-block w-0.5 rounded-full bg-orange-500/70"
                        style={{
                          height: 6 + (volume / 100) * 14 * Math.sin((Date.now() / 120 + i * 0.9) % (Math.PI * 2)),
                          opacity: 0.6 + (volume / 100) * 0.4,
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Stop — the only control: cancels LLM + TTS + mic, exits to text mode */}
          <Button
            onClick={onStop}
            size="sm"
            className="h-8 shrink-0 rounded-lg bg-[#1d3a5c] px-4 text-xs font-medium text-sky-200 hover:bg-[#24476e]"
            aria-label="Stop and exit voice mode"
          >
            <span className="mr-1.5 inline-flex gap-0.5" aria-hidden>
              <span className="size-1 rounded-full bg-sky-300" />
              <span className="size-1 rounded-full bg-sky-300" />
              <span className="size-1 rounded-full bg-sky-300" />
            </span>
            Stop
          </Button>
        </div>
      </div>
    </div>
  );
}
