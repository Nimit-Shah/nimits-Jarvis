/**
 * PIIVault — Per-request PII tokenization and restoration engine.
 *
 * Lifecycle:
 * 1. Created once per agent request.
 * 2. `redact()` / `redactToolResult()` called on outbound data before LLM.
 * 3. `restore()` called on the LLM's response before returning to user.
 * 4. Vault is garbage-collected when the request ends — mapping never persisted.
 *
 * Thread safety: Each request gets its own vault. No shared state.
 */

import { createHash } from "crypto";
import type { PIIMatch, PIIMapping, PIIType, PIIVaultStats } from "./pii-types";
import { scanForPII, scanForPIIEnhanced, extractStructuredPII } from "./pii-scanner";

/** Token format: email gets domain format, others get bracket format */
function makeToken(type: PIIType, index: number): string {
  const label = type.toUpperCase().replace(/_/g, "_");
  const hash = createHash("md5")
    .update(`${type}:${index}`)
    .digest("hex")
    .slice(0, 4)
    .toUpperCase();
  if (type === "email") {
    return `CLAW_EMAIL_${hash}@trustclaw.anon`;
  }
  return `[CLAW_${label}_${hash}]`;
}

export function isTokenString(s: string): boolean {
  return s.startsWith("[CLAW_") || s.endsWith("@trustclaw.anon");
}

/** Canonical form for forwardMap lookups: lowercase, trimmed, collapsed whitespace */
function canonicalizeForLookup(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** True if text contains a PII token anywhere (not necessarily bounded by word boundaries) */
const CONTAINS_TOKEN_RE = /(?:\[CLAW_[A-Z_]+_[A-F0-9]{4}\]|CLAW_EMAIL_[A-F0-9]{4}@trustclaw\.anon)/;
export function containsTokenPattern(text: string): boolean {
  return CONTAINS_TOKEN_RE.test(text);
}

export class PIIVault {
  /** Forward map: original value → token string. */
  private readonly forwardMap = new Map<string, string>();

  /** Reverse map: token string → original value. */
  private readonly reverseMap = new Map<string, string>();

  /** Counter per PII type for generating sequential token IDs. */
  private readonly counters = new Map<PIIType, number>();

  /** All mappings in insertion order. */
  private readonly mappings: PIIMapping[] = [];

  /**
   * Register a known PII value for redaction. If the same value was
   * already registered, the existing token is reused (deduplication).
   *
   * @returns The placeholder token.
   */
  registerPII(type: PIIType, value: string): string {
    const canonical = canonicalizeForLookup(value);
    if (!canonical) return value;

    // Dedup: reuse existing token for the same canonical value
    const existing = this.forwardMap.get(canonical);
    if (existing) return existing;

    const count = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, count);

    const token = makeToken(type, count);
    const trimmed = value.trim();
    this.forwardMap.set(canonical, token);
    this.reverseMap.set(token, trimmed);
    this.mappings.push({ token, original: trimmed, type });

    return token;
  }

  /**
   * Scan a text string for PII, replace all matches with tokens,
   * and return the redacted text.
   * 1. First replaces any already-registered PII values (from structured extraction).
   * 2. Then runs enhanced scanner (identity + regex + DeBERTa) for remaining PII.
   */
  async redact(text: string): Promise<string> {
    if (!text) return text;

    // Step 1: Replace known PII values registered from structured extraction.
    // Sort by length descending so longer strings replace first.
    let result = text;
    const sortedMappings = [...this.mappings].sort(
      (a, b) => b.original.length - a.original.length,
    );
    for (const mapping of sortedMappings) {
      if (result.includes(mapping.original)) {
        result = result.split(mapping.original).join(mapping.token);
      }
    }

    // Step 2: Run enhanced scanner for remaining PII patterns
    const matches = await scanForPIIEnhanced(result);
    if (matches.length === 0) return result;

    // Process matches from end-to-start so indices remain valid
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i]!;
      // Skip if already tokenized
      if (isTokenString(match.value)) continue;
      const token = this.registerPII(match.type, match.value);
      result = result.slice(0, match.start) + token + result.slice(match.end);
    }

    return result;
  }

  /**
   * Pre-register PII values extracted from structured tool results.
   * These are person names, emails, etc. found in known JSON fields
   * that might appear later in flattened text representations.
   */
  registerStructuredPII(obj: unknown): void {
    const matches = extractStructuredPII(obj);
    for (const match of matches) {
      this.registerPII(match.type, match.value);
    }
  }

  /**
   * Deep-walk a tool result object, redacting string values against
   * all currently registered PII values + scanning for new ones.
   *
   * Call `registerStructuredPII(result)` first to seed the vault
   * with known names/emails from the structured data, then call
   * this to redact everything.
   */
  async redactToolResult(result: unknown): Promise<unknown> {
    return this.deepRedact(result);
  }

  /**
   * Replace all PII tokens in text with the original values.
   * Used on the LLM's response before sending to the user.
   */
  restore(text: string): string {
    if (!text) return text;

    let result = text;
    // Replace tokens with originals. Iterate all mappings to handle
    // tokens that appear multiple times in the response.
    for (const mapping of this.mappings) {
      // Use split/join instead of regex to avoid special char issues
      while (result.includes(mapping.token)) {
        result = result.replace(mapping.token, mapping.original);
      }
    }

    return result;
  }

  /**
   * Deep-walk an arbitrary value and restore all PII tokens in string
   * values back to their original values.
   *
   * Mirrors the structure of redactToolResult but operates in reverse.
   */
  restoreDeep(value: unknown): unknown {
    return this.deepRestore(value);
  }

  /** Returns audit statistics about what was redacted. */
  getStats(): PIIVaultStats {
    const byType: Partial<Record<PIIType, number>> = {};
    for (const mapping of this.mappings) {
      byType[mapping.type] = (byType[mapping.type] ?? 0) + 1;
    }
    return {
      totalRedacted: this.mappings.length,
      byType,
    };
  }

  /** Returns true if any PII has been registered. */
  get hasRedactions(): boolean {
    return this.mappings.length > 0;
  }

  // ─── Private ───────────────────────────────────────────────────

  private async deepRedact(value: unknown, depth = 0): Promise<unknown> {
    // Safety: don't recurse infinitely (meta-tool results are deeply nested)
    if (depth > 25) return value;

    if (typeof value === "string") {
      return this.redactString(value);
    }

    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => this.deepRedact(item, depth + 1)));
    }

    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      const entries = Object.entries(value as Record<string, unknown>);
      for (const [key, val] of entries) {
        result[key] = await this.deepRedact(val, depth + 1);
      }
      return result;
    }

    return value;
  }

  private deepRestore(value: unknown, depth = 0): unknown {
    if (depth > 25) return value;

    if (typeof value === "string") {
      return this.restore(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.deepRestore(item, depth + 1));
    }

    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        result[key] = this.deepRestore(val, depth + 1);
      }
      return result;
    }

    return value;
  }

  /**
   * Redact a single string value:
   * 1. Replace any already-registered PII values (from structural extraction).
   * 2. Scan for new PII patterns (email, phone, etc.) and register+replace them.
   * Uses enhanced scanner (identity + regex + DeBERTa).
   */
  private async redactString(text: string): Promise<string> {
    if (!text || text.length < 3) return text;

    // Step 1: Replace known PII values (registered from structured extraction).
    // Sort by original length descending so longer strings are replaced first,
    // preventing substring corruption (e.g., "Johnson" before "John").
    let result = text;
    const sortedMappings = [...this.mappings].sort(
      (a, b) => b.original.length - a.original.length,
    );
    for (const mapping of sortedMappings) {
      if (result.includes(mapping.original)) {
        result = result.split(mapping.original).join(mapping.token);
      }
    }

    // Step 2: Scan for new PII patterns in the (partially redacted) text
    // We re-scan because the text may contain PII that wasn't in the
    // structured fields (e.g. email addresses in a message body).
    const newMatches = await scanForPIIEnhanced(result);
    if (newMatches.length === 0) return result;

    // Process from end to preserve indices
    for (let i = newMatches.length - 1; i >= 0; i--) {
      const match = newMatches[i]!;
      // Skip if this span was already replaced by a token
      if (isTokenString(match.value)) continue;

      const token = this.registerPII(match.type, match.value);
      result =
        result.slice(0, match.start) + token + result.slice(match.end);
    }

    return result;
  }
}
