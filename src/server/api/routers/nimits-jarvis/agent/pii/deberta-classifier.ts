/**
 * DeBERTa PII Classifier — Hugging Face token classification for
 * detecting unstructured PII (names, addresses, locations) in free text.
 *
 * Model: Isotonic/deberta-v3-base_finetuned_ai4privacy_v2
 * Runtime: ONNX via @huggingface/transformers (no PyTorch/Python required)
 *
 * This is Layer 3 of the PII pipeline: ML-based, 10-30ms latency.
 * Falls back gracefully if the model fails to load.
 *
 * Fix summary (2026-08-01):
 * - Root cause: pnpm strict isolation caused `onnxruntime-common` to be
 *   unresolvable by @huggingface/transformers ESM bundle. Fixed via symlink
 *   in the HF package's node_modules (see .npmrc for public-hoist-pattern).
 * - Second bug: the ONNX pipeline does NOT emit character start/end offsets.
 *   It only emits `word` (token piece) and `index` (token index). The old
 *   code did `text.slice(entity.start, entity.end)` which returned the full
 *   string when start/end are undefined. Fixed by:
 *     1. Running WITHOUT aggregation_strategy to get raw BIO-tagged tokens.
 *     2. Grouping consecutive tokens of the same entity type.
 *     3. Reconstructing span text from SentencePiece word pieces.
 *     4. Locating the span in the original text with indexOf for char offsets.
 * - Also added the full AI4Privacy label set (B-FIRSTNAME, B-MIDDLENAME,
 *   B-LASTNAME, B-CITY, B-STREET, etc.) to LABEL_TO_PII_TYPE.
 */

import type { PIIType } from "./pii-types";
import { containsTokenPattern } from "./pii-tokenizer";
import { isProtectedTerm } from "./protected-terms";

export interface ClassificationResult {
  value: string;
  category: PIIType;
  start: number;
  end: number;
  score: number;
}

/**
 * Map the AI4Privacy model label set → our PIIType.
 * The model uses BIO-tagged labels: B-FIRSTNAME, B-LASTNAME, B-EMAIL, etc.
 * We strip the B-/I- prefix and map the base label.
 */
const LABEL_TO_PII_TYPE: Record<string, PIIType> = {
  // Name components → person_name
  FIRSTNAME: "person_name",
  MIDDLENAME: "person_name",
  LASTNAME: "person_name",
  PREFIX: "person_name",
  SUFFIX: "person_name",
  USERNAME: "person_name",
  PERSON: "person_name",
  NAME: "person_name",
  // Contact
  EMAIL: "email",
  PHONE: "phone",
  PHONENUM: "phone",
  PHONENUMBER: "phone",
  // Location
  ADDRESS: "address",
  STREET: "address",
  CITY: "address",
  STATE: "address",
  ZIPCODE: "address",
  POSTCODE: "address",
  COUNTRY: "address",
  LOCATION: "address",
  COUNTY: "address",
  // Financial / IDs
  SSN: "ssn",
  SOCIALNUMBER: "ssn",
  CREDITCARDNUMBER: "credit_card",
  CREDIT_CARD: "credit_card",
  IP: "ip_address",
  IP_ADDRESS: "ip_address",
  IPADDRESS: "ip_address",
  APIKEY: "api_key",
  API_KEY: "api_key",
};

const CONFIDENCE_THRESHOLD = 0.80;
const MIN_TEXT_LENGTH = 10;
const MAX_TEXT_LENGTH = 2048; // DeBERTa v3 base max ~512 tokens; ~4 chars/token

// Circuit breaker: after MAX_CONSECUTIVE_FAILURES, skip for RETRY_COOLDOWN_MS
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_COOLDOWN_MS = 120_000;

let classifierInstance: any = null;
let consecutiveFailures = 0;
let lastFailureTime = 0;
let circuitLogged = false;
let lastLoadError: string | null = null; // underlying cause surfaced in circuit-open logs

/**
 * Lazy-load the DeBERTa model. Caches the instance after first load.
 * If the model fails to load, retries on the next request (up to
 * MAX_CONSECUTIVE_FAILURES before entering cooldown).
 */
async function getClassifier(): Promise<any> {
  if (classifierInstance) return classifierInstance;

  // Circuit breaker: after repeated failures, wait for cooldown
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    const elapsed = Date.now() - lastFailureTime;
    if (elapsed < RETRY_COOLDOWN_MS) {
      if (!circuitLogged) {
        console.error(
          `[DeBERTa] ⛔ CIRCUIT OPEN — ${consecutiveFailures} consecutive failures. ` +
            `PII Layer 3 (ML) is DOWN and will be skipped for the next ${Math.ceil((RETRY_COOLDOWN_MS - elapsed) / 1000)}s. ` +
            `Falling back to regex+identity only. Underlying cause: ${lastLoadError ?? "unknown"} `,
        );
        circuitLogged = true;
      }
      throw new Error("DeBERTa classifier unavailable (circuit open)");
    }
    consecutiveFailures = 0;
    circuitLogged = false;
    console.log("[DeBERTa] Circuit closed, retrying model load");
  }

  try {
    const { pipeline, env } = await import("@huggingface/transformers");
    const { homedir } = await import("os");
    const { join } = await import("path");

    // Cache model weights to ~/.cache/huggingface/hub so they survive process restarts.
    // env.cacheDir is the HF JS equivalent of HF_HOME — once the model is downloaded
    // it loads from disk in ~50ms instead of streaming from the Hub.
    env.cacheDir = join(homedir(), ".cache", "huggingface", "hub");
    env.allowRemoteModels = true;

    classifierInstance = await pipeline(
      "token-classification",
      "Isotonic/deberta-v3-base_finetuned_ai4privacy_v2",
    );

    // Reset the failure counter only when the model actually loaded
    consecutiveFailures = 0;
    circuitLogged = false;
    console.log(`[DeBERTa] ✅ Model loaded successfully (after ${consecutiveFailures} recorded failure(s) this cycle)`);
    return classifierInstance;
  } catch (err) {
    consecutiveFailures++;
    lastFailureTime = Date.now();
    lastLoadError = `${(err as NodeJS.ErrnoException).code ?? ""} ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`.trim();
    console.error(
      `[DeBERTa] ⛔ MODEL LOAD FAILED (attempt ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}). ` +
        `PII Layer 3 (ML) is NOT running — falling back to regex+identity only.`,
      err,
    );
    throw new Error(
      `DeBERTa classifier failed to load after ${consecutiveFailures} attempt(s)`,
    );
  }
}

/**
 * Extract the base label from a BIO-tagged label.
 * e.g., "B-FIRSTNAME" → "FIRSTNAME", "I-LASTNAME" → "LASTNAME", "PERSON" → "PERSON"
 */
function baseLabel(label: string): string {
  return label.replace(/^[BI]-/i, "").toUpperCase();
}

/**
 * Group consecutive tokens that belong to the same entity type into
 * merged spans, returning { label, words[], score_avg }.
 *
 * This is needed because the ONNX pipeline does NOT emit character
 * start/end offsets — only `word` (token piece) and `index` (token index).
 *
 * Key insight: DeBERTa uses sub-word tokenization. A single word like
 * "Nimit" may produce two tokens: {entity:"B-FIRSTNAME", word:"N", index:4}
 * and {entity:"B-FIRSTNAME", word:"imit", index:5}. Both carry a B- tag
 * but are consecutive and same label — they must be merged.
 *
 * Merge rule: consecutive token index + same base label, regardless of B/I.
 */
function groupConsecutiveTokens(
  entities: Array<{ entity: string; score: number; index: number; word: string }>,
): Array<{ label: string; words: string[]; score: number }> {
  const groups: Array<{ label: string; words: string[]; score: number; totalLen: number; lastIndex: number }> = [];

  for (const e of entities) {
    const label = baseLabel(e.entity);
    const last = groups[groups.length - 1];
    const wordLen = e.word.length;

    if (last && last.label === label && e.index === last.lastIndex + 1) {
      last.words.push(e.word);
      last.score = (last.score * last.totalLen + e.score * wordLen) / (last.totalLen + wordLen);
      last.totalLen += wordLen;
      last.lastIndex = e.index;
    } else {
      groups.push({ label, words: [e.word], score: e.score, totalLen: wordLen, lastIndex: e.index });
    }
  }

  return groups.map(({ label, words, score }) => ({ label, words, score }));
}

/**
 * Reconstruct a human-readable string from SentencePiece token pieces.
 *
 * SentencePiece tokenization rules:
 * - Word-initial tokens are prefixed with ▁ (U+2581): e.g. "▁Nimit", "▁Shah"
 * - Sub-word continuations have NO prefix: e.g. "N" → "imit" makes "Nimit"
 * - When joining: ▁ prefix = space before the word; no prefix = concat directly.
 */
function reconstructSpan(words: string[]): string {
  let result = "";
  for (const w of words) {
    if (w.startsWith("▁")) {
      // Word boundary — add a space then the word (trim leading ▁)
      result += (result.length > 0 ? " " : "") + w.slice(1);
    } else {
      // Sub-word continuation — concatenate directly (no space)
      result += w;
    }
  }
  return result.trim();
}

/**
 * Find the character position of `span` in `text` starting after `fromIndex`,
 * requiring that the match is a WHOLE word (not a substring of a larger token).
 *
 * This prevents partial-span corruption where a reconstructed DeBERTa span like
 * "Jarv" (a token-piece fragment of "Jarvis") would otherwise match inside
 * "Jarvis" and be tokenized, leaving "...vis" behind →
 * "[CLAW_PERSON_NAME_XXXX]vis".
 */
function findWholeWordSpan(
  text: string,
  span: string,
  fromIndex = 0,
): { start: number; end: number } | null {
  let idx = fromIndex;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    idx = text.indexOf(span, idx);
    if (idx === -1) return null;
    const before = text.charAt(idx - 1);
    const after = text.charAt(idx + span.length);
    const wordBoundaryBefore =
      idx === 0 || !/[a-zA-Z0-9_]/.test(before);
    const wordBoundaryAfter = !/[a-zA-Z0-9_]/.test(after);
    if (wordBoundaryBefore && wordBoundaryAfter) {
      // Extra guard: the span must not be a component of a larger functional
      // identifier (path, extension, kebab model/package name). Otherwise a
      // fragment like "composio" inside "composio.ts" or "jar" inside
      // "nimits-jarvis" would be tokenized, corrupting the surrounding text.
      if (isIdentifierFragment(text, span, idx)) {
        idx += 1;
        continue;
      }
      return { start: idx, end: idx + span.length };
    }
    // Not a whole word — keep searching after this occurrence
    idx += 1;
  }
}

/**
 * True if `span` at `idx` is a component of a larger identifier rather than a
 * standalone word. Expands outward over word + separator chars and flags only
 * clearly-functional forms:
 *  - paths / URLs (contain "/")
 *  - extension / domain components ("composio.ts", "example.com") — a trailing
 *    sentence period ("Nimits.") is NOT flagged, so real names survive
 *  - all-lowercase kebab identifiers ("nimits-jarvis", "claude-agent-sdk")
 * Mixed-case hyphenated proper names ("Nitesh-Singh") are NOT flagged and
 * remain detectable.
 */
function isIdentifierFragment(
  text: string,
  span: string,
  idx: number,
): boolean {
  const SEP = /[a-zA-Z0-9_./-]/;
  let start = idx;
  let end = idx + span.length;
  while (start > 0 && SEP.test(text.charAt(start - 1))) start--;
  while (end < text.length && SEP.test(text.charAt(end))) end++;
  const expanded = text.slice(start, end);
  if (expanded === span) return false;
  // Paths / URLs always contain a slash.
  if (expanded.includes("/")) return true;
  // A dot followed by a letter-run = extension or domain component
  // (composio.ts, example.com). A trailing period after a name is NOT one.
  if (/\.[a-zA-Z]{1,10}(?:[.][a-zA-Z]{2,4})?/.test(expanded)) return true;
  // All-lowercase kebab identifiers. Mixed-case hyphenated proper names
  // (Nitesh-Singh) are intentionally NOT flagged.
  if (expanded.includes("-") && !/[A-Z]/.test(expanded)) return true;
  return false;
}

/**
 * Guard function to skip machine-generated identifiers, tool slugs, API parameter names,
 * and code symbols from DeBERTa classification.
 *
 * DeBERTa v3 is trained on prose and frequently misclassifies SCREAMING_SNAKE_CASE
 * (e.g. OPENWEATHERMAP_GET_GEOCODING_DIRECT) or camelCase code identifiers as person names.
 */
function isLikelyMachineString(text: string): boolean {
  const trimmed = text.trim();
  // SCREAMING_SNAKE_CASE tool slugs & constants: OPENWEATHERMAP_GET_GEOCODING_DIRECT, GMAIL_FETCH_EMAILS
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(trimmed)) return true;
  // Any single token containing underscores (snake_case or SCREAMING_SNAKE_CASE)
  if (trimmed.includes("_") && !trimmed.includes(" ")) return true;
  // All-uppercase words with no spaces (acronyms/methods: API, HTTP, GET, POST, URL, JSON)
  if (/^[A-Z]{2,}$/.test(trimmed)) return true;
  // camelCase code identifiers: geocodingDirect, countryCode, maxResults
  if (/^[a-z]+(?:[A-Z][a-z0-9]+)+$/.test(trimmed)) return true;
  // Lowercase kebab / dotted identifiers: nimits-jarvis, composio.ts,
  // claude-4.5-sonnet, @composio/claude-agent-sdk (model IDs, package names,
  // file names). DeBERTa frequently misclassifies their segments as names.
  if (/^[a-z0-9]+(?:[-.][a-z0-9]+)+$/.test(trimmed)) return true;
  return false;
}

/**
 * Classify PII entities in text using DeBERTa token classification.
 * Returns an array of detected PII entities with positions and confidence scores.
 * Returns empty array if model is unavailable or text is too short.
 */
export async function classifyPII(
  text: string,
): Promise<ClassificationResult[]> {
  if (!text || text.trim().length < MIN_TEXT_LENGTH) return [];
  if (isLikelyMachineString(text)) return [];

  const classifier = await getClassifier();

  try {
    // Run WITHOUT aggregation_strategy to get raw BIO-tagged tokens with indices.
    // The aggregated version drops start/end offsets in the ONNX build.
    const truncated = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
    const rawEntities = await classifier(truncated);

    if (!rawEntities || !Array.isArray(rawEntities)) return [];

    // Filter to only PII labels above confidence threshold
    const piiEntities = (
      rawEntities as Array<{
        entity: string;
        score: number;
        index: number;
        word: string;
      }>
    ).filter((e) => {
      const label = baseLabel(e.entity);
      return e.score >= CONFIDENCE_THRESHOLD && LABEL_TO_PII_TYPE[label] !== undefined;
    });

    if (piiEntities.length === 0) return [];

    // Group consecutive tokens of the same type into coherent spans
    const groups = groupConsecutiveTokens(piiEntities);

    const results: ClassificationResult[] = [];
    let searchFrom = 0;

    for (const group of groups) {
      const piiType = LABEL_TO_PII_TYPE[group.label];
      if (!piiType) continue;

      const spanValue = reconstructSpan(group.words);
      if (!spanValue || spanValue.length < 2) continue;

      // Skip already-tokenized values (incl. nested/unbracketed tokens) or
      // machine identifiers (tool slugs, param names)
      if (containsTokenPattern(spanValue) || isLikelyMachineString(spanValue)) continue;

      // Skip protected terms (agent/product names, functional IDs) — never redact
      if (isProtectedTerm(spanValue)) continue;

      // Locate the span in the original text as a whole word to get offsets
      const pos = findWholeWordSpan(text, spanValue, searchFrom);
      if (!pos) {
        // Fallback: emit without exact positions (still seeds the vault)
        results.push({ value: spanValue, category: piiType, start: 0, end: 0, score: group.score });
        continue;
      }

      results.push({
        value: spanValue,
        category: piiType,
        start: pos.start,
        end: pos.end,
        score: group.score,
      });
      searchFrom = pos.end;
    }

    return results;
  } catch (err) {
    console.warn("[DeBERTa] Classification error:", err);
    return [];
  }
}

/**
 * Check if DeBERTa model is available (loaded successfully).
 */
export function isDeBERTaAvailable(): boolean {
  return classifierInstance !== null;
}

/**
 * Reset classifier state (for testing). Forces next call to re-attempt model load.
 */
export function resetDeBERTa(): void {
  classifierInstance = null;
  consecutiveFailures = 0;
  lastFailureTime = 0;
  circuitLogged = false;
}

/**
 * Force the circuit breaker open (for testing the fail-closed path).
 * After calling this, getClassifier() will throw until cooldown expires
 * or resetDeBERTa() is called.
 */
export function forceCircuitOpen(): void {
  classifierInstance = null;
  consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
  lastFailureTime = Date.now();
  circuitLogged = false;
}

/**
 * Pre-warm the model (call early to avoid cold start on first request).
 * Non-blocking — fires and forgets.
 */
export function prewarmDeBERTa(): void {
  if (!classifierInstance && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
    void getClassifier().catch(() => {
      // Model prewarm failed — non-fatal, next request will retry
    });
  }
}
