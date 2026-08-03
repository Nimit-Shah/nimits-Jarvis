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
import { isProtectedTerm } from "./protected-terms";

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
const CONTAINS_TOKEN_RE = /(?:\[?CLAW_\[?[A-Z_]+_[A-F0-9]{4}\]?|CLAW_EMAIL_[A-F0-9]{4}@trustclaw\.anon)/;
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

    // NEVER tokenize protected terms (agent name, product name, functional
    // IDs). Returning the value unchanged means redaction is a no-op for it.
    if (isProtectedTerm(value)) return value;

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
    for (const mapping of this.mappings) {
      // Match exact token (with brackets for non-email, domain format for email)
      while (result.includes(mapping.token)) {
        result = result.replace(mapping.token, mapping.original);
      }
      if (mapping.token.startsWith("CLAW_EMAIL_")) {
        // Email tokens are domain-format with NO brackets on the local part.
        // The LLM sometimes wraps the local part in brackets anyway (following the
        // "tokens are wrapped in []" instruction in the system prompt), producing
        // "[CLAW_EMAIL_FE1A]@trustclaw.anon". Tolerate an optional surrounding
        // bracket so such text still resolves back to the real email.
        const at = mapping.token.indexOf("@");
        const local = mapping.token.slice(0, at);
        const domain = mapping.token.slice(at);
        const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(
          `\\[?\\s*${esc(local)}\\s*\\]?\\${esc(domain)}`,
          "g",
        );
        result = result.replace(re, mapping.original);
      } else {
        // Match unbracketed token — the LLM may strip brackets in prose
        // (e.g., [CLAW_PERSON_NAME_542F] → CLAW_PERSON_NAME_542F in thought fields).
        const unbracketed = mapping.token.slice(1, -1); // strip [ and ]
        while (result.includes(unbracketed)) {
          result = result.replace(unbracketed, mapping.original);
        }
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
        const lowerKey = key.toLowerCase();
        if (SYSTEM_METADATA_KEYS.has(lowerKey)) {
          // Bypass PII scanning for structural API metadata, tool slugs, and schemas
          result[key] = val;
        } else {
          result[key] = await this.deepRedact(val, depth + 1);
        }
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

    // Step 1: Replace known PII values (registered from structural extraction).
    // Sort by original length descending so longer strings are replaced first.
    // Use word boundaries for word/alphanumeric strings to avoid substring corruption
    // (e.g., prevents "coun" from replacing inside "Country" or "County").
    let result = text;
    const sortedMappings = [...this.mappings].sort(
      (a, b) => b.original.length - a.original.length,
    );
    for (const mapping of sortedMappings) {
      const orig = mapping.original;
      if (!result.includes(orig)) continue;

      if (/^\w+$/.test(orig)) {
        const regex = new RegExp(`\\b${escapeRegExp(orig)}\\b`, "g");
        result = result.replace(regex, mapping.token);
      } else {
        result = result.split(orig).join(mapping.token);
      }
    }

    // Step 2: Scan for new PII patterns in the (partially redacted) text
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

/**
 * Object key names representing structural API metadata, tool definitions, schemas,
 * multi-language translations (local_names), or technical IDs that must NEVER be
 * modified by PII redaction or tokenization.
 */
const SYSTEM_METADATA_KEYS = new Set([
  // Tool definition / schema metadata
  "tool_slug",
  "toolslug",
  "toolname",
  "tool_name",
  "toolcallid",
  "tool_call_id",
  "action",
  "parameters",
  "schema",
  "properties",
  "enum",
  "required",
  "description",
  "type",
  "format",
  // Composio tool-router schema guidance (trusted machine-generated boilerplate,
  // not user data). Skipped so DeBERTa/regex don't inject tokens into guidance
  // text the LLM should read verbatim.
  "known_pitfalls",
  "knownpitfalls",
  "execution_guidance",
  "recommended_plan_steps",
  "next_steps_guidance",
  "usecase",
  "use_case",
  "related_tool_slugs",
  "primary_tool_slugs",
  "toolkits",
  // Geographic / API response translation dicts & metadata
  "local_names",
  "localnames",
  "name_ascii",
  "country_code",
  "countrycode",
  "country",
  "state_code",
  "iso3166",
  "lat",
  "lon",
  "icon",
  "weather",
  // Technical / API pagination / system & account IDs
  "nextpagetoken",
  "pagetoken",
  "threadid",
  "messageid",
  "historyid",
  "plan_id",
  "auth_config_id",
  "authconfigid",
  "connected_account_id",
  "connectedaccountid",
  "user_id",
  "userid",
  "account_id",
  "accountid",
  "display_url",
  "file_path",
  "mimetype",
  "mime_type",
  "code",
  "status",
  "etag",
]);

function escapeRegExp(str: string): string {
  return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
}

