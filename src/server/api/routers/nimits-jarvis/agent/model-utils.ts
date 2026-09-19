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
 * Maintained list of Ollama vision-capable model families. Ollama's
 * /api/tags response carries only names (no modality signal), so this stays
 * a curated list in one place — update here when new families land.
 */
const OLLAMA_VISION_FAMILIES = [
  "llava",
  "qwen2-vl",
  "qwen2.5-vl",
  "minicpm-v",
  "bakllava",
  "moondream",
  "gemma3",
];

/** Substrings marking OpenRouter/Anthropic models with native vision input. */
const VISION_MODEL_HINTS = [
  "claude",
  "gpt-4o",
  "gpt-4.1",
  "gpt-5",
  "gemini",
  "qwen-vl",
  "qwen2-vl",
  "qwen2.5-vl",
  "llava",
  "vision",
  "pixtral",
  "mistral-medium",
  "grok-vision",
  "sonar-pro",
];

/**
 * Vision capability for image attachments. Sync fast path over model-family
 * hints; `"unknown"` when the catalog has no entry — unknown means
 * allow-with-warning, never block. Composer gates on `false`; server
 * re-checks via `resolveVisionCapability` and rejects loudly on `false`.
 *
 * Deliberately no vendor deny-rules here: on 2026-09-18 the static
 * `deepseek → false` rule silently discarded uploads for
 * `deepseek-v4.1-flash`, which the OpenRouter catalog lists with
 * `input_modalities: ["text","image"]`. Guessing `false` blocks legitimately
 * capable models — only affirmatively text-only families return `false`.
 */
export function supportsVision(modelId: string): boolean | "unknown" {
  const id = modelId.toLowerCase().replace(/^openrouter\//, "");
  const provider = getModelProvider(modelId);
  if (provider === "anthropic") return true;
  if (provider === "ollama") {
    const base = id.split(":")[0] ?? id;
    if (OLLAMA_VISION_FAMILIES.some((f) => base.includes(f))) return true;
    // qwen3:8b-class text models are the default — known incapable.
    if (base.startsWith("qwen3") || base.startsWith("llama3") || base === "qwen3:8b") return false;
    return "unknown";
  }
  if (VISION_MODEL_HINTS.some((h) => id.includes(h))) return true;
  return "unknown";
}

interface OpenRouterCatalogEntry {
  id: string;
  canonical_slug?: string;
  architecture?: { input_modalities?: string[] };
}

const visionCatalogCache = new Map<string, { at: number; value: boolean | "unknown" }>();
const VISION_CATALOG_TTL_MS = 60 * 60 * 1000;

/**
 * Data-driven vision capability: OpenRouter `architecture.input_modalities`
 * (verified 2026-09-18 across 446 models), 1h in-memory TTL. Falls back to
 * the sync hint path when the key is absent, the fetch fails, or the model
 * is not OpenRouter-routed. Never throws — worst case returns the hint value.
 */
export async function resolveVisionCapability(modelId: string): Promise<boolean | "unknown"> {
  const hint = supportsVision(modelId);
  if (hint !== "unknown" || getModelProvider(modelId) !== "openrouter") return hint;
  const key = modelId.toLowerCase();
  const cached = visionCatalogCache.get(key);
  if (cached && Date.now() - cached.at < VISION_CATALOG_TTL_MS) return cached.value;
  try {
    const apiKey = env.OPENROUTER_API_KEY;
    if (!apiKey) return hint;
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return hint;
    const data = (await res.json()) as { data: OpenRouterCatalogEntry[] };
    const bare = key.replace(/^openrouter\//, "");
    const entry = data.data.find(
      (m) => m.id.toLowerCase() === bare || m.canonical_slug?.toLowerCase() === bare,
    );
    const value: boolean | "unknown" = entry?.architecture?.input_modalities?.includes("image")
      ? true
      : "unknown";
    // A catalog hit without image modality is still just absence of evidence —
    // keep "unknown" (allow-with-warning) rather than blocking.
    visionCatalogCache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return hint;
  }
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