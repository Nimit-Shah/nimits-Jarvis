/**
 * Model-aware context window sizes.
 *
 * Maps known model IDs to their maximum context window in tokens.
 * Unknown models fall back to a conservative 128K default — large
 * enough for useful conversations but small enough to avoid sending
 * oversized payloads to models with smaller windows.
 */

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Local / Ollama
  "qwen3:8b": 16_000,

  // Anthropic (direct)
  "claude-sonnet-4-5-20250929": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,

  // Anthropic models
  "anthropic/claude-sonnet-4-5-20250929": 200_000,
  "anthropic/claude-opus-4-6": 200_000,
  "anthropic/claude-haiku-4-5-20251001": 200_000,

  // OpenAI models
  "openai/gpt-4o": 128_000,
  "openai/gpt-4o-mini": 128_000,
  "openai/gpt-4.1": 1_047_576,
  "openai/gpt-4.1-mini": 1_047_576,
  "openai/gpt-4.1-nano": 1_047_576,
  "openai/o3": 200_000,
  "openai/o3-mini": 200_000,
  "openai/o4-mini": 200_000,

  // DeepSeek
  "deepseek/deepseek-chat": 64_000,
  "deepseek/deepseek-reasoner": 64_000,
  "deepseek/deepseek-v4-flash": 64_000,

  // Google
  "google/gemini-2.5-flash": 1_048_576,
  "google/gemini-2.5-pro": 1_048_576,
  "google/gemini-2.0-flash": 1_048_576,

  // Meta / Llama
  "meta/llama-4-scout": 512_000,
  "meta/llama-4-maverick": 256_000,

  // Mistral
  "mistral/mistral-large-latest": 128_000,
  "mistral/mistral-small-latest": 128_000,
};

import { getModelProvider } from "../model-utils";

/** Safe fallback for models we don't have a mapping for. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

export function getContextWindow(modelId: string): number {
  const provider = getModelProvider(modelId);
  if (provider === "ollama") {
    return MODEL_CONTEXT_WINDOWS[modelId] ?? 16_000;
  }
  return MODEL_CONTEXT_WINDOWS[modelId] ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Computes a safe character budget for an intermediate LLM pass (e.g. context
 * compaction / memory flush) on a given model.
 *
 * Derives the cap from the model's context window (via getContextWindow) so it
 * generalizes across ALL providers — DeepSeek, Gemini, GPT, Llama, Claude,
 * local Ollama, and any future model. A safety ratio reserves headroom for the
 * system prompt + the model's output so we don't blow past the window.
 *
 * Rough conversion: ~4 chars ≈ 1 token.
 */
const SUMMARIZATION_SAFETY_RATIO = 0.5;
const CHARS_PER_TOKEN = 4;

export function computeSummarizationBudget(modelId: string): number {
  const contextTokens = getContextWindow(modelId);
  const reservedTokens = Math.floor(contextTokens * SUMMARIZATION_SAFETY_RATIO);
  return reservedTokens * CHARS_PER_TOKEN;
}
