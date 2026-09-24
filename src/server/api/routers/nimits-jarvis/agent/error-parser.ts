import { z } from "zod";

const composioApiErrorSchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
        suggested_fix: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

export function parseAgentError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  const jsonMatch = /\d{3}\s*(\{.*\})/.exec(raw);
  if (jsonMatch?.[1]) {
    try {
      const rawJson: unknown = JSON.parse(jsonMatch[1]);
      const parsed = composioApiErrorSchema.safeParse(rawJson);
      if (parsed.success) {
        if (parsed.data.error?.suggested_fix) {
          return parsed.data.error.suggested_fix;
        }
        if (parsed.data.error?.message) {
          return parsed.data.error.message;
        }
      }
    } catch {
      // Fall through
    }
  }

  if (raw.includes("invalid x-api-key") || raw.includes("invalid_api_key")) {
    return "Invalid Anthropic API key. Please check the server configuration.";
  }

  if (raw.includes("rate_limit") || raw.includes("429")) {
    return "Rate limit exceeded. Please wait a moment and try again.";
  }

  return "Something went wrong. Please try again.";
}

const GUARDRAIL_RE = /prompt injection/i;

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function statusCodeOf(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  ) {
    return (error as { statusCode: number }).statusCode;
  }
  return undefined;
}

/**
 * Formats any stream/generation error into a short, user-readable message
 * safe to send to the client via toUIMessageStreamResponse's onError.
 * Never leaks stack traces, file paths, or API keys.
 */
export function formatStreamError(error: unknown): string {
  const raw = extractMessage(error);

  // Aborts are user-initiated — not an error worth a scary toast.
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || raw === "aborted" || raw.includes("aborted by user")) {
    return "Stopped.";
  }

  // OpenRouter guardrail (403) — operator-actionable, not a server fault.
  if (GUARDRAIL_RE.test(raw)) {
    return "Blocked by OpenRouter content guardrails (prompt-injection pattern in this chat's history). Adjust the guardrail in your OpenRouter workspace, or start a new chat.";
  }

  const status = statusCodeOf(error);
  if (status === 401) {
    return "The model provider rejected our API key. Check the server configuration.";
  }
  if (status === 402) {
    return "The model provider account is out of credits. Top it up and retry.";
  }
  if (status === 403) {
    return "The model provider blocked this request. If this repeats, check your OpenRouter guardrail settings.";
  }
  if (status === 429 || raw.includes("rate_limit") || raw.includes("429")) {
    return "Rate limit exceeded. Please wait a moment and try again.";
  }
  if (status !== undefined && status >= 500) {
    return `The model provider returned an error (${status}). Please try again shortly.`;
  }

  if (/timed? ?out|timeout/i.test(raw)) {
    return "The request timed out. Please try again.";
  }
  if (/fetch failed|network|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return "Network error reaching the model provider. Check connectivity and retry.";
  }
  if (raw.includes("invalid x-api-key") || raw.includes("invalid_api_key")) {
    return "Invalid Anthropic API key. Please check the server configuration.";
  }

  // Reuse the Composio/known-message parser when it produces something better.
  const parsed = parseAgentError(error);
  if (parsed !== "Something went wrong. Please try again.") return parsed;

  // Last resort: a bounded excerpt of the raw message (already free of
  // stacks/paths by construction — error.message only), else generic.
  const excerpt = raw.trim().slice(0, 200);
  if (
    excerpt &&
    excerpt !== "[object Object]" &&
    excerpt !== "undefined" &&
    excerpt !== "null"
  ) {
    return excerpt;
  }
  return "Something went wrong. Please try again.";
}
