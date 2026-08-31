"use client";

/**
 * @deprecated Removed from the inline bar per user feedback (the floating ✳
 * circle was distracting). Kept for reference only — not imported anywhere.
 */
import { cn } from "~/lib/utils";

/**
 * Claude starburst (coral ✳) — pulses while speaking/thinking.
 * Frame_060.jpg: center-left above glow, 20-24px, opacity 0.85, gentle scale.
 */
export function VoiceStarburst({ active, volume }: { active: boolean; volume: number }) {
  const scale = active ? 1 + (volume / 100) * 0.25 : 0.9;
  const opacity = active ? 0.9 : 0;
  return (
    <div
      className={cn("select-none transition-all duration-150", !active && "pointer-events-none")}
      style={{ opacity, transform: `scale(${scale})` }}
      aria-hidden
    >
      <div className="flex size-6 items-center justify-center rounded-full bg-[#ff7a5c]/15 ring-1 ring-[#ff7a5c]/20">
        <span className="text-[18px] leading-none text-[#ff7a5c]">✳</span>
      </div>
    </div>
  );
}
