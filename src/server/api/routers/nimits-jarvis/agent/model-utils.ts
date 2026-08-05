/**
 * Model provider classification and context window utilities.
 *
 * Centralises the "which provider does this model ID belong to?" logic
 * so every call-site (agent setup, compaction, memory-flush) can use a
 * clean switch instead of ad-hoc string checks.
 */

export type ModelProvider = "ollama" | "anthropic" | "openrouter";

const ANTHROPIC_MODEL_PREFIXES = [
  "claude-",
  "anthropic/",
];

import { ollamaProvider } from "~/server/clients/ollama";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { env } from "~/env";

/**
 * Determines the provider category for a given model ID.
 *
 * - `"ollama"` — local Ollama models (e.g. `qwen3:8b`)
 * - `"anthropic"` — Anthropic models, either bare (`claude-sonnet-4-5-…`)
 *   or namespaced (`anthropic/claude-…`)
 * - `"openrouter"` — anything else with a `/` prefix (e.g. `openrouter/deepseek/…`,
 *   `openai/gpt-4o-mini`) routed through OpenRouter
 */
export function getModelProvider(modelId: string): ModelProvider {
  if (modelId.startsWith("openrouter/")) {
    return "openrouter";
  }

  for (const prefix of ANTHROPIC_MODEL_PREFIXES) {
    if (modelId.startsWith(prefix)) {
      return "anthropic";
    }
  }

  if (modelId.includes("/")) {
    return "openrouter";
  }

  return "ollama";
}

/**
 * Returns true if the model is an Anthropic model that supports
 * provider-specific options like `cacheControl`.
 */
export function isAnthropicModel(modelId: string): boolean {
  return getModelProvider(modelId) === "anthropic";
}

/**
 * Resolves a model ID string into the format expected by the AI SDK.
 *
 * - Ollama models → handled separately via `ollamaProvider()`
 * - OpenRouter models → strip `openrouter/` prefix
 * - Bare Anthropic model names → prefixed with `anthropic/`
 * - Other `/` models → used as-is (OpenRouter compatible)
 */
export function resolveModelId(modelId: string): string {
  if (modelId.startsWith("openrouter/")) {
    return modelId.replace("openrouter/", "");
  }
  if (modelId.includes("/")) {
    return modelId;
  }
  return `anthropic/${modelId}`;
}

/**
 * Builds a ready-to-use model instance based on the model ID's provider.
 *
 * Generic across ALL providers (Ollama local, OpenRouter-routed models like
 * DeepSeek/Gemini/GPT/Llama, and bare Anthropic). The `modelId` is a free-form
 * model-ID string (stored on the chat), NOT limited to Anthropic.
 *
 * This must be used everywhere a model is constructed (main agent, compaction,
 * memory-flush) so background tasks use a provider instead of passing a bare
 * string (which the AI SDK cannot route without a default provider).
 */
export function buildLLM(modelId: string) {
  const provider = getModelProvider(modelId);
  if (provider === "ollama") {
    return ollamaProvider(modelId);
  }
  if (provider === "openrouter") {
    return createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })(
      resolveModelId(modelId),
    );
  }
  // bare Anthropic model — used as-is (SDK resolves via anthropic provider)
  return resolveModelId(modelId);
}

/** Base timeout for intermediate LLM calls (compaction/memory-flush). */
const BASE_LLM_TIMEOUT_MS = 30_000;
/** Extra ms granted per ~2KB of serialized input. */
const TIMEOUT_MS_PER_2KB = 2_000;
/** Hard ceiling so a runaway input can't hold a worker forever. */
const MAX_LLM_TIMEOUT_MS = 120_000;

/**
 * Returns an adaptive timeout (ms) that scales with the size of the text being
 * sent to the LLM, capped at MAX_LLM_TIMEOUT_MS. Generalized across any model —
 * no hard-coded per-model values.
 */
export function llmTimeoutFor(text: string): number {
  const extra =
    Math.floor(text.length / 2048) * TIMEOUT_MS_PER_2KB;
  return Math.min(BASE_LLM_TIMEOUT_MS + extra, MAX_LLM_TIMEOUT_MS);
}