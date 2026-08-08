import type { PIIVault } from "./pii-tokenizer";

/**
 * Matches any residual PII token that `restore()` could not resolve — tokens
 * persisted by a previous request whose per-request vault mapping is gone.
 * Because the mapping is never persisted, the real value is unrecoverable; the
 * only safe action at a human boundary is to drop the placeholder (→ "[redacted]")
 * so it never reaches a user on any channel.
 */
const RESIDUAL_TOKEN_RE =
  /(?:CLAW_EMAIL_[A-F0-9]{4}@trustclaw\.anon|\[CLAW_EMAIL_[A-F0-9]{4}\]@trustclaw\.anon|\[CLAW_[A-Z_]+_[A-F0-9]{4}\]|CLAW_[A-Z_]+_[A-F0-9]{4})/g;

/**
 * Strips any residual PII token placeholders from human-facing text. Logs a
 * warning whenever one is found so unresolved tokens stay diagnosable.
 */
export function stripResidualTokens(text: string): string {
  if (!text) return text;
  const matches = text.match(RESIDUAL_TOKEN_RE);
  if (!matches) return text;
  console.warn(
    `[pii] stripped ${matches.length} unresolvable PII token(s) from human-facing output`,
  );
  return text.replace(RESIDUAL_TOKEN_RE, "[redacted]");
}

/** Deep variant of stripResidualTokens for structured payloads. */
export function deepStripResidualTokens(value: unknown, depth = 0): unknown {
  if (depth > 25) return value;
  if (typeof value === "string") return stripResidualTokens(value);
  if (Array.isArray(value)) {
    return value.map((item) => deepStripResidualTokens(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = deepStripResidualTokens(val, depth + 1);
    }
    return result;
  }
  return value;
}

/**
 * Branded string types that encode which side of the PII boundary a piece of
 * text belongs to, at the type level.
 *
 * - `TokenizedText`: text that contains PII tokens (never real PII). This is
 *   the ONLY form the cloud LLM may ever see.
 * - `RealText`: text with real, restored PII values. This is the ONLY form a
 *   human (on any channel) or a third-party tool may ever see.
 *
 * The invariant the project enforces:
 *   CLOUD LLM  = TokenizedText (tokens only)
 *   HUMAN/tool = RealText     (real values only)
 *
 * These are branded (nominal) string types, so a `string` cannot be silently
 * used where a `TokenizedText` or `RealText` is expected — skipping conversion
 * at a boundary becomes a compile error, not a silent bug.
 */

declare const __tokenized: unique symbol;
export type TokenizedText = string & { readonly [__tokenized]: true };

declare const __real: unique symbol;
export type RealText = string & { readonly [__real]: true };

/**
 * Marks text as ALREADY tokenized (safe for the LLM). This is a no-op at
 * runtime — it exists purely to make the tokenized-state explicit at the type
 * level where the message payload is handed to the model.
 */
export function toModel(text: string): TokenizedText {
  return text as TokenizedText;
}

/**
 * The ONLY sanctioned way to produce human-facing text from tokenized text.
 * Wraps vault.restore(); if no vault is active, the text passes through
 * unchanged (local models run on-device with no redaction).
 */
export function toHuman(vault: PIIVault | null, text: TokenizedText): RealText {
  if (!vault) return text as unknown as RealText;
  // restore() resolves every token this vault knows. Any token it can't
  // resolve (a cross-request orphan) must be stripped so a placeholder never
  // reaches the human.
  return stripResidualTokens(vault.restore(text)) as RealText;
}

/**
 * Deep variant of toHuman for structured payloads (tool inputs/outputs that
 * may contain tokens nested inside objects/arrays). Returns real values.
 */
export function toHumanDeep(vault: PIIVault | null, value: unknown): unknown {
  if (!vault) return value;
  return deepStripResidualTokens(vault.restoreDeep(value));
}
