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
    // Store the RAW matched span (not the trimmed value) as the restore value so
    // restore() reinserts the exact original text including any surrounding
    // whitespace/separators. The dedup key stays canonical-trimmed, so "Nimit "
    // and "Nimit" share one token while restore returns the first-seen form.
    this.reverseMap.set(token, value);
    this.mappings.push({ token, original: value, type });

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
      result = replaceRegisteredValue(result, mapping.original, mapping.token);
    }

    // Step 2: Run enhanced scanner for remaining PII patterns
    const matches = await scanForPIIEnhanced(result);
    if (matches.length === 0) return result;

    // Idempotency: locate existing tokens so a new match that overlaps one is
    // skipped (never re-tokenize an already-tokenized span, even partially).
    const tokenSpans = findTokenSpans(result);

    // Process matches from end-to-start so indices remain valid
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i]!;
      if (this.shouldSkipMatch(match, tokenSpans)) continue;
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
      // Container-aware functional-entity detection: objects that carry file or
      // repo metadata (a `path` + `type` + a content URL) use `name` / `full_name`
      // for the FILENAME / repo id, NOT a person. Bypass those sibling values too,
      // even though `name` / `full_name` are otherwise PII heuristic keys.
      const isFileLikeEntity =
        hasOwn(value, "path") &&
        hasOwn(value, "type") &&
        (hasOwn(value, "download_url") || hasOwn(value, "html_url"));
      // Container-aware plan detection: GitHub's `plan` object carries exactly
      // these three numeric siblings. Its `name` is the billing tier
      // (free/pro/team/enterprise), NOT a person — bypass it too.
      const isPlanLikeEntity =
        hasOwn(value, "space") &&
        hasOwn(value, "collaborators") &&
        hasOwn(value, "private_repos");
      for (const [key, val] of entries) {
        const lowerKey = key.toLowerCase();
        if (
          SYSTEM_METADATA_KEYS.has(lowerKey) ||
          // Any *_url key is a functional URL field (GitHub API templates like
          // archive_url/branches_url/clone_url/svn_url/ssh_url, avatar_url, etc.)
          // and must pass through verbatim so the login embedded in it stays
          // consistent with `login`/`html_url`. EXCEPT the LinkedIn keys below,
          // which are person-level PII and must keep being redacted.
          (lowerKey.endsWith("_url") && !LINKEDIN_URL_KEYS.has(lowerKey)) ||
          ((isFileLikeEntity || isPlanLikeEntity) &&
            (lowerKey === "name" || lowerKey === "full_name"))
        ) {
          // Bypass PII scanning for structural API metadata, tool slugs, schemas,
          // and functional file/repo identifiers
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
    // Uses whole-word boundaries so a value never corrupts a larger identifier
    // (e.g. prevents "coun" replacing inside "Country"/"County" and prevents
    // "Nimits" replacing inside "Nimits-jarvis" or "composio.ts").
    let result = text;
    const sortedMappings = [...this.mappings].sort(
      (a, b) => b.original.length - a.original.length,
    );
    for (const mapping of sortedMappings) {
      result = replaceRegisteredValue(result, mapping.original, mapping.token);
    }

    // Step 2: Scan for new PII patterns in the (partially redacted) text
    const newMatches = await scanForPIIEnhanced(result);
    if (newMatches.length === 0) return result;

    // Idempotency: locate existing tokens so a new match that overlaps one is
    // skipped (never re-tokenize an already-tokenized span, even partially).
    const tokenSpans = findTokenSpans(result);

    // Process from end to preserve indices
    for (let i = newMatches.length - 1; i >= 0; i--) {
      const match = newMatches[i]!;
      if (this.shouldSkipMatch(match, tokenSpans)) continue;
      const token = this.registerPII(match.type, match.value);
      result =
        result.slice(0, match.start) + token + result.slice(match.end);
    }

    return result;
  }

  /**
   * Whether a scanner match should be skipped before tokenization.
   *
   * 1. Idempotency: a match whose value already contains a PII token (including
   *    nested or unbracketed forms that `isTokenString` misses) is never
   *    re-tokenized.
   * 2. Min-length: a 1-char "name" is noise, not PII — never mint a token for it.
   * 3. Zero-width: DeBERTa may emit a seed-only match when it cannot locate the
   *    span ({start:0,end:0}). Register it so a later pass can resolve it, but
   *    never slice-replace (a 0/0 slice would PREPEND the token to the text and
   *    corrupt it).
   * 4. Overlap: a match overlapping an existing token span is a fragment of an
   *    already-tokenized value.
   */
  private shouldSkipMatch(
    match: PIIMatch,
    tokenSpans: Array<{ start: number; end: number }>,
  ): boolean {
    if (containsTokenPattern(match.value)) return true;
    if (match.value.trim().length < 2) return true;
    if (match.start === 0 && match.end === 0) {
      this.registerPII(match.type, match.value);
      return true;
    }
    for (const s of tokenSpans) {
      if (match.start < s.end && match.end > s.start) return true;
    }
    return false;
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
  // Path / file metadata (GitHub content, file uploads, downloads) — the LLM
  // must be able to read these verbatim to reason about repositories and paths.
  "path",
  "file",
  "filename",
  "file_name",
  "extension",
  "default_branch",
  "download_url",
  "html_url",
  "blob_url",
  "git_url",
  // Repo / account functional identifiers — `login` is excluded deliberately:
  // it is technically a username, but the agent needs it to reference repos
  // (owner/login) and redacting it produced nested-token corruption.
  "repo",
  "repository",
  "login",
  "slug",
  "ref",
  "sha",
  "branch",
  "node_id",
  // GitHub account / API URL fields — these embed the login (e.g.
  // https://api.github.com/users/Nimit-Shah/followers) and the agent must be
  // able to read them verbatim to match against `login` / `html_url`. Keeping
  // them unredacted keeps all GitHub URL forms consistent (html_url / git_url /
  // download_url were already bypassed).
  "url",
  "avatar_url",
  "followers_url",
  "following_url",
  "gists_url",
  "starred_url",
  "subscriptions_url",
  "organizations_url",
  "repos_url",
  "events_url",
  "received_events_url",
  "comments_url",
  // Model / version / provider identifiers
  "model",
  "model_id",
  "version",
  "provider",
  // Request / session / job plumbing
  "session_id",
  "sessionid",
  "requestid",
  "request_id",
  "logid",
  "taskid",
  "jobid",
  "execution_id",
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

/**
 * Keys ending in `_url` that are NOT functional URLs but person-level PII.
 * The `_url`-suffix bypass (deepRedact) must never swallow these — they are
 * exactly the LinkedIn profile-identifier keys the structural heuristics flag.
 * Keeping this list small is intentional: any other *_url key is treated as a
 * functional API URL (clone_url, svn_url, archive_url, avatar_url, ...).
 */
const LINKEDIN_URL_KEYS = new Set([
  "profile_url",
  "profileurl",
  "vanity_url",
  "vanityname",
  "vanity_name",
  "publicidentifier",
]);

/** Own-property check that is safe against prototype pollution. */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function escapeRegExp(str: string): string {
  return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
}

/**
 * Replace a registered original value with its token, matching ONLY as a whole
 * word when the value is a plain word. This is the single boundary rule applied
 * at EVERY replacement point (redact() and redactString()).
 *
 * Boundaries EXCLUDE `.`, `/`, `-`, `_` — so a registered "Nimits" never matches
 * inside "Nimits-jarvis", "composio.ts", or "Nimits_1", and a registered
 * "composio" never matches inside "composio.ts". Only genuine word boundaries
 * (space, punctuation, string edges, unicode letters) trigger a replacement.
 * Multi-word / non-word values (emails, URLs) fall back to an escaped exact match.
 */
function replaceRegisteredValue(
  text: string,
  original: string,
  token: string,
): string {
  if (!text.includes(original)) return text;
  if (/^\w+$/.test(original)) {
    const regex = new RegExp(
      `(?<![a-zA-Z0-9_./-])${escapeRegExp(original)}(?![a-zA-Z0-9_./-])`,
      "g",
    );
    return text.replace(regex, token);
  }
  return text.split(original).join(token);
}

/** Global variant of CONTAINS_TOKEN_RE for walking all token spans in text. */
const CONTAINS_TOKEN_GLOBAL_RE = new RegExp(CONTAINS_TOKEN_RE.source, "g");

/**
 * Returns the [start, end) spans of every PII token present in `text`.
 * Used for idempotency: a new scan match overlapping an existing token span is
 * a fragment of an already-tokenized value and must not be re-tokenized.
 */
function findTokenSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  if (!text) return spans;
  CONTAINS_TOKEN_GLOBAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONTAINS_TOKEN_GLOBAL_RE.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

