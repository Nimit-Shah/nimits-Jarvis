/**
 * Per-section token accounting for one LLM request (docs/TOKEN_EFFICIENCY.md §0.1).
 *
 * Estimates are `chars / 3.6` — the ratio matters more than the absolute,
 * and it is stable enough to compare phases. Section split:
 *   system       serialized system prompt
 *   tools        serialized tool definitions
 *   history      every message except the current turn
 *   current      the current turn
 *   toolResults  subset of history that is tool-role messages
 */

import type { ReconstructedMessage } from "./types";

const CHARS_PER_TOKEN = 3.6;

export interface SectionTokens {
  system: number;
  tools: number;
  history: number;
  current: number;
  toolResults: number;
}

function estChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function tokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

export function estimateSectionTokens(
  system: string,
  tools: unknown,
  messages: ReconstructedMessage[],
): SectionTokens {
  let toolResultChars = 0;
  let totalChars = 0;
  for (const msg of messages) {
    const chars = estChars(msg.content);
    totalChars += chars;
    if (msg.role === "tool") {
      toolResultChars += chars;
    }
  }
  const currentChars = estChars(messages.at(-1)?.content);
  return {
    system: tokens(estChars(system)),
    tools: tokens(estChars(tools)),
    history: tokens(totalChars - currentChars),
    current: tokens(currentChars),
    toolResults: tokens(toolResultChars),
  };
}
