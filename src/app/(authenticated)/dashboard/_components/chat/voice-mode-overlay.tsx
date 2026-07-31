"use client";

import { useEffect, useRef, useCallback } from "react";
import { X, Mic, MicOff, Loader2, ShieldAlert } from "lucide-react";
import type { JarvisVoiceState } from "./use-jarvis-voice";
import type { MicPermissionState } from "./use-mic-permission";

interface VoiceModeOverlayProps {
  isOpen: boolean;
  jarvisState: JarvisVoiceState;
  micPermission: MicPermissionState;
  volume: number;
  lastTranscription: string;
  error: string | null;
  onClose: () => void;
  onRequestMicPermission: () => Promise<boolean>;
}

// ── Orb animation class ────────────────────────────────────────────────────────

function getOrbClass(state: JarvisVoiceState): string {
  switch (state) {
    case "SPEAKING_GREETING":
    case "SPEAKING_RESPONSE":
      return "jarvis-orb-speaking";
    case "PROCESSING":
      return "jarvis-orb-processing";
    case "LISTENING":
      return "jarvis-orb-listen";
    default:
      return "jarvis-orb-listen";
  }
}

function getStatusLabel(state: JarvisVoiceState): string {
  switch (state) {
    case "SPEAKING_GREETING": return "Initialising...";
    case "LISTENING": return "Listening...";
    case "PROCESSING": return "Thinking...";
    case "SPEAKING_RESPONSE": return "Speaking...";
    default: return "Tap to speak";
  }
}

// ── Neural Canvas ──────────────────────────────────────────────────────────────

function useNeuralCanvas(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  isOpen: boolean,
  volume: number,
) {
  const animFrameRef = useRef<number>(0);
  const particlesRef = useRef<
    Array<{ x: number; y: number; vx: number; vy: number; r: number }>
  >([]);

  useEffect(() => {
    if (!isOpen) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = (canvas.width = canvas.offsetWidth);
    const H = (canvas.height = canvas.offsetHeight);
    const cx = W / 2;
    const cy = H / 2;
    const PARTICLE_COUNT = 60;
    const MAX_DIST = 110;
    const ORB_R = 90;

    if (particlesRef.current.length === 0) {
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = ORB_R + Math.random() * 130;
        particlesRef.current.push({
          x: cx + Math.cos(angle) * dist,
          y: cy + Math.sin(angle) * dist,
          vx: (Math.random() - 0.5) * 0.4,
          vy: (Math.random() - 0.5) * 0.4,
          r: Math.random() * 1.8 + 0.8,
        });
      }
    }

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      const speedBoost = 1 + (volume / 100) * 2.5;

      for (const p of particlesRef.current) {
        p.x += p.vx * speedBoost;
        p.y += p.vy * speedBoost;

        const margin = 30;
        if (p.x < margin) p.vx += 0.05;
        if (p.x > W - margin) p.vx -= 0.05;
        if (p.y < margin) p.vy += 0.05;
        if (p.y > H - margin) p.vy -= 0.05;

        const dx = p.x - cx;
        const dy = p.y - cy;
        const distFromCenter = Math.sqrt(dx * dx + dy * dy);
        if (distFromCenter < ORB_R + 15) {
          p.vx += (dx / distFromCenter) * 0.12;
          p.vy += (dy / distFromCenter) * 0.12;
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(249, 115, 22, 0.85)";
        ctx.fill();
      }

      for (let i = 0; i < particlesRef.current.length; i++) {
        for (let j = i + 1; j < particlesRef.current.length; j++) {
          const a = particlesRef.current[i]!;
          const b = particlesRef.current[j]!;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < MAX_DIST) {
            const alpha = (1 - dist / MAX_DIST) * 0.45;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = `rgba(249, 115, 22, ${alpha})`;
            ctx.lineWidth = 0.7;
            ctx.stroke();
          }
        }
      }

      animFrameRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      particlesRef.current = [];
    };
  }, [isOpen, canvasRef, volume]);
}

// ── Permission Screen ──────────────────────────────────────────────────────────

function PermissionScreen({
  state,
  errorMessage,
  onRequest,
  onClose,
}: {
  state: MicPermissionState;
  errorMessage?: string | null;
  onRequest: () => void;
  onClose: () => void;
}) {
  if (state === "denied") {
    return (
      <div className="jarvis-overlay-enter fixed inset-0 z-50 flex flex-col items-center justify-center"
        style={{ background: "radial-gradient(ellipse at center, rgba(0,8,20,0.97) 0%, rgba(0,4,12,0.99) 100%)" }}
      >
        <button
          onClick={onClose}
          className="absolute right-6 top-6 z-10 rounded-full p-2 text-orange-400/60 transition-colors hover:bg-orange-950/40 hover:text-orange-300"
          aria-label="Close voice mode"
        >
          <X className="size-5" />
        </button>

        <div className="flex flex-col items-center gap-6 px-8 text-center">
          <div className="flex size-20 items-center justify-center rounded-full border border-red-500/30 bg-red-950/20">
            <ShieldAlert className="size-10 text-red-400" />
          </div>
          <div>
            <h2 className="font-mono text-lg font-bold tracking-wide text-orange-200">
              Microphone Blocked
            </h2>
            <p className="mt-2 max-w-sm font-mono text-xs leading-relaxed text-red-400">
              {errorMessage || "Your browser has blocked microphone access for this site."}
            </p>
          </div>
          <div className="max-w-sm rounded-lg border border-orange-900/30 bg-orange-950/15 p-4 text-left font-mono text-xs text-orange-400/80">
            <p className="font-semibold text-orange-300">Chrome / Edge:</p>
            <p className="mt-1">Click the 🔒 icon in the address bar → Site settings → Microphone → Allow</p>
            <p className="mt-3 font-semibold text-orange-300">Safari:</p>
            <p className="mt-1">Safari → Settings → Websites → Microphone → Allow for this site</p>
          </div>
          {/* Try again button — works if user just fixed settings without refreshing */}
          <button
            onClick={onRequest}
            className="rounded-lg border border-orange-800/40 bg-orange-950/20 px-5 py-2 font-mono text-xs text-orange-400 transition-colors hover:border-orange-600/60 hover:bg-orange-900/30 hover:text-orange-300"
          >
            Try Again
          </button>
          <p className="font-mono text-[10px] uppercase tracking-widest text-orange-800/40">
            Or refresh the page after changing settings
          </p>
        </div>
      </div>
    );
  }

  // prompt / unknown state
  return (
    <div className="jarvis-overlay-enter fixed inset-0 z-50 flex flex-col items-center justify-center"
      style={{ background: "radial-gradient(ellipse at center, rgba(0,8,20,0.97) 0%, rgba(0,4,12,0.99) 100%)" }}
    >
      <button
        onClick={onClose}
        className="absolute right-6 top-6 z-10 rounded-full p-2 text-orange-400/60 transition-colors hover:bg-orange-950/40 hover:text-orange-300"
        aria-label="Close voice mode"
      >
        <X className="size-5" />
      </button>

      <div className="flex flex-col items-center gap-6 px-8 text-center">
        <button
          onClick={onRequest}
          className="group flex size-24 items-center justify-center rounded-full border border-orange-500/30 bg-orange-950/20 transition-all hover:border-orange-400/50 hover:bg-orange-900/30 hover:shadow-lg hover:shadow-orange-500/10"
          aria-label="Allow microphone access"
        >
          <Mic className="size-10 text-orange-400 transition-transform group-hover:scale-110" />
        </button>
        <div>
          <h2 className="font-mono text-lg font-bold tracking-wide text-orange-200">
            Allow Microphone
          </h2>
          <p className="mt-2 max-w-xs font-mono text-xs leading-relaxed text-orange-500/70">
            Jarvis needs access to your microphone to listen to your voice commands.
            Tap the icon above to allow.
          </p>
        </div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-orange-700/40">
          Audio is processed locally — never sent to any cloud
        </p>
      </div>
    </div>
  );
}

// ── Main Overlay ───────────────────────────────────────────────────────────────

export function VoiceModeOverlay({
  isOpen,
  jarvisState,
  micPermission,
  volume,
  lastTranscription,
  error,
  onClose,
  onRequestMicPermission,
}: VoiceModeOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useNeuralCanvas(canvasRef, isOpen && micPermission === "granted", volume);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const handlePermissionRequest = useCallback(() => {
    void onRequestMicPermission();
  }, [onRequestMicPermission]);

  if (!isOpen) return null;

  // ── Show permission screen if mic not yet granted ──
  if (micPermission !== "granted") {
    return (
      <PermissionScreen
        state={micPermission}
        errorMessage={error}
        onRequest={handlePermissionRequest}
        onClose={onClose}
      />
    );
  }

  // ── Main Jarvis Voice Interface ──
  const isListening = jarvisState === "LISTENING";
  const isSpeaking = jarvisState === "SPEAKING_GREETING" || jarvisState === "SPEAKING_RESPONSE";
  const isProcessing = jarvisState === "PROCESSING";
  const isActive = isListening || isSpeaking || isProcessing;

  // Dynamic scale factor — orb grows with voice volume during listening
  const orbScale = isListening ? 1 + (volume / 100) * 0.22 : 1;
  const orbClass = getOrbClass(jarvisState);

  return (
    <div
      className="jarvis-overlay-enter fixed inset-0 z-50 flex flex-col items-center justify-center"
      style={{
        background:
          "radial-gradient(ellipse at center, rgba(0,8,20,0.97) 0%, rgba(0,4,12,0.99) 100%)",
      }}
    >
      {/* Neural network particle canvas */}
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />

      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute right-6 top-6 z-10 rounded-full p-2 text-orange-400/60 transition-colors hover:bg-orange-950/40 hover:text-orange-300"
        aria-label="Close voice mode"
      >
        <X className="size-5" />
      </button>

      {/* Header */}
      <div className="relative z-10 mb-12 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.35em] text-orange-500/50">
          J.A.R.V.I.S
        </p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-orange-700/40">
          Voice Interface Active
        </p>
      </div>

      {/* Orb */}
      <div className="relative z-10 flex items-center justify-center">
        {/* Expanding rings (shown while active) */}
        {isActive && (
          <>
            <div
              className="jarvis-ring absolute rounded-full border border-orange-400/30"
              style={{ width: 220, height: 220 }}
            />
            <div
              className="jarvis-ring-delay absolute rounded-full border border-orange-500/20"
              style={{ width: 220, height: 220 }}
            />
          </>
        )}

        {/* Outer glow halo */}
        <div
          className="absolute rounded-full"
          style={{
            width: 200,
            height: 200,
            background:
              "radial-gradient(circle, rgba(249,115,22,0.18) 0%, transparent 70%)",
            filter: "blur(20px)",
            transform: `scale(${orbScale})`,
            transition: "transform 60ms linear",
          }}
        />

        {/* The Orb itself */}
        <div
          className={`${orbClass} relative flex items-center justify-center`}
          style={{
            width: 160,
            height: 160,
            background:
              isActive
                ? "radial-gradient(circle at 38% 38%, #F97316 0%, #B45309 45%, #78350F 100%)"
                : "radial-gradient(circle at 38% 38%, #FB923C 0%, #92400E 55%, #451A03 100%)",
            boxShadow: isActive
              ? "0 0 50px rgba(249,115,22,0.55), 0 0 100px rgba(180,83,9,0.3), inset 0 0 30px rgba(251,146,60,0.25)"
              : "0 0 30px rgba(217,119,6,0.25), 0 0 60px rgba(146,64,14,0.15), inset 0 0 20px rgba(245,158,11,0.12)",
            transform: `scale(${orbScale})`,
            transition: "transform 60ms linear, box-shadow 300ms ease",
          }}
        >
          {isProcessing ? (
            <Loader2 className="size-8 animate-spin text-orange-200/80" />
          ) : isListening ? (
            <Mic className="size-8 text-orange-100/90" />
          ) : isSpeaking ? (
            <MicOff className="size-8 text-orange-100/70" />
          ) : (
            <Mic className="size-8 text-orange-300/70" />
          )}
        </div>
      </div>

      {/* Status label */}
      <div className="relative z-10 mt-10 text-center">
        <p className="font-mono text-sm tracking-widest text-orange-400/80">
          {error ? (
            <span className="text-red-400">{error}</span>
          ) : (
            getStatusLabel(jarvisState)
          )}
        </p>
        {isListening && (
          <p className="mt-2 font-mono text-[11px] text-orange-600/50">
            Stop speaking to auto-send
          </p>
        )}
      </div>

      {/* Transcription preview */}
      {lastTranscription && (
        <div className="relative z-10 mx-auto mt-8 max-w-md rounded-lg border border-orange-900/40 bg-orange-950/20 px-5 py-3 text-center backdrop-blur-sm">
          <p className="font-mono text-xs italic text-orange-300/70">
            &ldquo;{lastTranscription}&rdquo;
          </p>
        </div>
      )}

      {/* Footer hint */}
      <p className="absolute bottom-8 left-0 right-0 z-10 text-center font-mono text-[10px] uppercase tracking-widest text-orange-800/40">
        Press Esc to close
      </p>
    </div>
  );
}
