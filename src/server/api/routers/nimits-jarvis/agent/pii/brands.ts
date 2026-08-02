import type { PIIVault } from "./pii-tokenizer";

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
  return (vault ? vault.restore(text) : text) as RealText;
}

/**
 * Deep variant of toHuman for structured payloads (tool inputs/outputs that
 * may contain tokens nested inside objects/arrays). Returns real values.
 */
export function toHumanDeep(vault: PIIVault | null, value: unknown): unknown {
  return vault ? vault.restoreDeep(value) : value;
}
