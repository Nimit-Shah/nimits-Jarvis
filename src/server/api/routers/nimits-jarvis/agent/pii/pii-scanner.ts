/**
 * PII Scanner — Detects personally identifiable information in text and
 * structured data using regex patterns and heuristic rules.
 *
 * Design principles:
 * - **No external API calls** — all detection is local, so we don't
 *   accidentally send PII to another service.
 * - **False positives > false negatives** — over-redacting is acceptable;
 *   under-redacting (leaking a real SSN to OpenAI) is not.
 * - **Structural extraction** — Composio tool results are JSON objects
 *   with known fields (from.name, sender, author, attendees[].name).
 *   We extract these before flattening to text.
 */

import type { PIIMatch, PIIType } from "./pii-types";
import { IdentityRegistry } from "./identity-registry";
import { classifyPII } from "./deberta-classifier";

// ─── Regex Patterns ────────────────────────────────────────────────

/**
 * RFC 5322 email regex. Intentionally broad to catch edge cases.
 * Excludes very short TLDs to avoid matching version numbers like `v2.0`.
 */
const EMAIL_RE =
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

/**
 * International phone numbers. Matches:
 * - +1 (234) 567-8901
 * - +44 7911 123456
 * - +91-98765-43210
 * - (234) 567-8901
 * - 234-567-8901
 * - 2345678901 (10+ digits)
 */
const PHONE_RE =
  /\b(?:\+\d{1,3}[\s\-.]?)?\(?\d{2,4}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}(?:\s*(?:ext|x)\s*\d{1,5})?/g;

/**
 * Credit card numbers: 13-19 digits, optionally separated by spaces or dashes.
 * We validate with Luhn in post-processing.
 */
const CREDIT_CARD_RE =
  /\b(?:\d[\s\-]?){13,19}\b/g;

/** US Social Security Number: XXX-XX-XXXX. */
const SSN_RE =
  /\b\d{3}-\d{2}-\d{4}\b/g;

/** IPv4 addresses. */
const IPV4_RE =
  /\b(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;

/**
 * API keys and tokens. Matches common prefixes:
 * sk-, pk-, ghp_, gho_, ghs_, ghr_, xoxb-, xoxp-, xoxa-, Bearer, etc.
 * Also catches generic long alphanumeric strings (32+ chars) that look like secrets.
 */
const API_KEY_RE =
  /\b(?:sk-[a-zA-Z0-9]{20,}|pk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,}|ghs_[a-zA-Z0-9]{36,}|ghr_[a-zA-Z0-9]{36,}|xox[bpa]-[a-zA-Z0-9\-]{20,}|sk-ant-[a-zA-Z0-9\-]{20,}|AIza[a-zA-Z0-9\-_]{35})\b/g;

/** URNs (Uniform Resource Names), commonly used for LinkedIn IDs (urn:li:person:12345) and other internal identifiers */
const URN_RE =
  /\burn:[a-zA-Z0-9\-]+:[a-zA-Z0-9\-:]+\b/gi;

/** LinkedIn Profile URLs */
const LINKEDIN_URL_RE =
  /https?:\/\/(?:www\.)?linkedin\.com\/(?:in|pub|company|school)\/[a-zA-Z0-9_-]+/gi;

/**
 * US street addresses. Heuristic: a number followed by words and a street suffix,
 * optionally followed by a 5-digit ZIP.
 */
const ADDRESS_RE =
  /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,4}(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Rd|Road|Way|Ct|Court|Pl(?:ace)?|Cir(?:cle)?|Hwy|Highway)\.?\s*(?:,\s*[A-Za-z\s]+,?\s*(?:[A-Z]{2}\s+)?\d{5}(?:-\d{4})?)?\b/gi;

// ─── Luhn Validation ───────────────────────────────────────────────

function passesLuhn(numStr: string): boolean {
  const digits = numStr.replace(/[\s\-]/g, "");
  if (!/^\d+$/.test(digits) || digits.length < 13 || digits.length > 19) {
    return false;
  }
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i]!, 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// ─── Scanner ───────────────────────────────────────────────────────

interface PatternEntry {
  type: PIIType;
  regex: RegExp;
  validate?: (match: string, fullText?: string, matchIndex?: number) => boolean;
}

const PATTERNS: PatternEntry[] = [
  // Order matters: more specific patterns first to prevent overlaps
  { type: "ssn", regex: SSN_RE },
  { type: "email", regex: EMAIL_RE },
  { type: "api_key", regex: API_KEY_RE },
  { type: "linkedin_url", regex: LINKEDIN_URL_RE },
  { type: "urn", regex: URN_RE },
  {
    type: "credit_card",
    regex: CREDIT_CARD_RE,
    validate: passesLuhn,
  },
  { type: "ip_address", regex: IPV4_RE },
  {
    type: "phone", regex: PHONE_RE, validate: (m, text, idx) => {
      // Must have at least 10 digits to be a real phone number
      const digits = m.replace(/\D/g, "");
      if (digits.length < 10) return false;
      // Reject if preceded by alphanumeric (resource ID like "c123456789036")
      if (idx !== undefined && text && idx > 0) {
        const prev = text.charAt(idx - 1);
        if (/[a-zA-Z0-9]/.test(prev)) return false;
      }
      return true;
    }
  },
  { type: "address", regex: ADDRESS_RE },
];

/**
 * Scans a text string for PII entities using regex patterns.
 * Returns all matches sorted by start position.
 *
 * Overlapping matches are deduplicated: if two matches overlap,
 * the more specific (earlier in the pattern list) wins.
 */
export function scanForPII(text: string): PIIMatch[] {
  const allMatches: PIIMatch[] = [];

  for (const pattern of PATTERNS) {
    // Reset regex state for each scan
    pattern.regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const value = match[0].trim();
      if (!value) continue;

      // Run optional validator (e.g. Luhn for credit cards, phone context check)
      if (pattern.validate && !pattern.validate(value, text, match.index)) {
        continue;
      }

      allMatches.push({
        type: pattern.type,
        value,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  // Sort by start position, then deduplicate overlaps
  allMatches.sort((a, b) => a.start - b.start);
  return deduplicateOverlaps(allMatches);
}

/**
 * When matches overlap, keep the one that appears first in our priority
 * list (more specific type wins).
 */
function deduplicateOverlaps(matches: PIIMatch[]): PIIMatch[] {
  const result: PIIMatch[] = [];
  let lastEnd = -1;

  for (const match of matches) {
    if (match.start >= lastEnd) {
      result.push(match);
      lastEnd = match.end;
    }
    // else: overlapping with a higher-priority match → skip
  }

  return result;
}

// ─── Structural PII Extraction ─────────────────────────────────────

/**
 * Known JSON paths in Composio tool results that contain PII.
 * These are dot-separated paths where `[]` indicates array traversal.
 */
const PII_FIELD_PATHS: Array<{
  /** Dot-separated path segments. `*` matches any key (for arrays). */
  path: string[];
  type: PIIType;
}> = [
    // Email / Gmail
    { path: ["from", "emailAddress", "name"], type: "person_name" },
    { path: ["from", "emailAddress", "address"], type: "email" },
    { path: ["sender", "emailAddress", "name"], type: "person_name" },
    { path: ["sender", "emailAddress", "address"], type: "email" },
    { path: ["toRecipients", "*", "emailAddress", "name"], type: "person_name" },
    { path: ["toRecipients", "*", "emailAddress", "address"], type: "email" },
    { path: ["ccRecipients", "*", "emailAddress", "name"], type: "person_name" },
    { path: ["ccRecipients", "*", "emailAddress", "address"], type: "email" },

    // Gmail API format
    { path: ["from"], type: "person_name" },
    { path: ["to"], type: "person_name" },
    { path: ["sender_email"], type: "email" },
    { path: ["recipient_email"], type: "email" },

    // Calendar / Events
    { path: ["attendees", "*", "name"], type: "person_name" },
    { path: ["attendees", "*", "email"], type: "email" },
    { path: ["organizer", "name"], type: "person_name" },
    { path: ["organizer", "email"], type: "email" },

    // Contacts
    { path: ["name"], type: "person_name" },
    { path: ["displayName"], type: "person_name" },
    { path: ["givenName"], type: "person_name" },
    { path: ["surname"], type: "person_name" },
    { path: ["emailAddresses", "*", "address"], type: "email" },
    { path: ["phoneNumbers", "*", "number"], type: "phone" },
    { path: ["homePhones", "*"], type: "phone" },
    { path: ["mobilePhone"], type: "phone" },
    { path: ["businessPhones", "*"], type: "phone" },

    // Gmail People API (people.get / people.searchDirectoryPeople)
    { path: ["names", "*", "displayName"], type: "person_name" },
    { path: ["names", "*", "givenName"], type: "person_name" },
    { path: ["names", "*", "familyName"], type: "person_name" },
    { path: ["emailAddresses", "*", "value"], type: "email" },

    // Slack / Discord
    { path: ["author", "name"], type: "person_name" },
    { path: ["user", "name"], type: "person_name" },
    { path: ["user", "real_name"], type: "person_name" },
    { path: ["user", "profile", "email"], type: "email" },
    { path: ["user", "profile", "phone"], type: "phone" },
  ];

/**
 * Extracts PII values from known structured fields in Composio tool results.
 *
 * This catches person names, emails, and phone numbers that are embedded
 * in JSON objects with predictable schemas — without relying on NER or
 * external APIs.
 *
 * Uses two strategies:
 * 1. **Exact path matching** — known JSON paths from specific APIs (Gmail, Slack, etc.)
 * 2. **Key-name heuristic** — any field whose key name matches common PII fields
 *    (e.g. `name`, `email`, `phone`) at any nesting depth. This catches PII from
 *    the 500+ Composio integrations whose schemas we can't enumerate.
 */
export function extractStructuredPII(obj: unknown): PIIMatch[] {
  if (!obj || typeof obj !== "object") return [];

  const matches: PIIMatch[] = [];
  const seen = new Set<string>(); // Deduplicate by value

  // Strategy 1: Exact path matching
  for (const fieldPath of PII_FIELD_PATHS) {
    const values = extractValuesAtPath(obj, fieldPath.path, 0);
    for (const value of values) {
      if (typeof value === "string" && value.trim().length > 1) {
        const trimmed = value.trim();
        if (trimmed.length <= 1 || isObviousNonPII(trimmed)) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);

        matches.push({
          type: fieldPath.type,
          value: trimmed,
          start: 0, // structural matches don't have text positions
          end: 0,
        });
      }
    }
  }

  // Strategy 2: Deep-walk key-name heuristic
  // Catches PII in any JSON field at any depth whose key name suggests PII content.
  const heuristicMatches = deepWalkPIIByKeyName(obj);
  for (const match of heuristicMatches) {
    if (!seen.has(match.value)) {
      seen.add(match.value);
      matches.push(match);
    }
  }

  return matches;
}

/**
 * JSON key names that strongly indicate PII content.
 * Maps key names → PII type. Matching is case-insensitive.
 */
const PII_KEY_HEURISTICS: Record<string, PIIType> = {
  // Person names
  name: "person_name",
  displayname: "person_name",
  display_name: "person_name",
  fullname: "person_name",
  full_name: "person_name",
  givenname: "person_name",
  given_name: "person_name",
  firstname: "person_name",
  first_name: "person_name",
  lastname: "person_name",
  last_name: "person_name",
  surname: "person_name",
  real_name: "person_name",
  author_name: "person_name",
  sender_name: "person_name",
  recipient_name: "person_name",
  // Emails
  email: "email",
  emailaddress: "email",
  email_address: "email",
  sender_email: "email",
  recipient_email: "email",
  // Phones
  phone: "phone",
  phonenumber: "phone",
  phone_number: "phone",
  mobilephone: "phone",
  mobile_phone: "phone",
  mobile: "phone",
  // URN / IDs
  urn: "urn",
  linkedin_urn: "urn",
  linkedin_id: "urn",
  // Social / Links
  profileurl: "linkedin_url",
  profile_url: "linkedin_url",
  vanityname: "linkedin_url",
  vanity_name: "linkedin_url",
  publicidentifier: "linkedin_url",
};

/**
 * Recursively walks an object tree and extracts string values from fields
 * whose key names match known PII indicators. Works at any depth.
 */
function deepWalkPIIByKeyName(
  obj: unknown,
  depth = 0,
): PIIMatch[] {
  if (depth > 25) return []; // Safety: prevent infinite recursion
  if (!obj || typeof obj !== "object") return [];

  const matches: PIIMatch[] = [];

  if (Array.isArray(obj)) {
    for (const item of obj) {
      matches.push(...deepWalkPIIByKeyName(item, depth + 1));
    }
    return matches;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    const piiType = PII_KEY_HEURISTICS[normalizedKey];

    if (piiType && typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 1 && !isObviousNonPII(trimmed)) {
        matches.push({
          type: piiType,
          value: trimmed,
          start: 0,
          end: 0,
        });
      }
    }

    // Recurse into nested objects/arrays regardless of key match
    if (typeof value === "object" && value !== null) {
      matches.push(...deepWalkPIIByKeyName(value, depth + 1));
    }
  }

  return matches;
}

/**
 * Recursively extracts values from an object following a dot-path.
 * `*` in the path matches all indices of an array.
 */
function extractValuesAtPath(
  obj: unknown,
  path: string[],
  depth: number,
): unknown[] {
  if (depth >= path.length) return [obj];
  if (!obj || typeof obj !== "object") return [];

  const key = path[depth]!;

  if (key === "*" && Array.isArray(obj)) {
    const results: unknown[] = [];
    for (const item of obj) {
      results.push(...extractValuesAtPath(item, path, depth + 1));
    }
    return results;
  }

  const value = (obj as Record<string, unknown>)[key];
  if (value === undefined) return [];

  return extractValuesAtPath(value, path, depth + 1);
}

/**
 * Simple heuristic to skip values that look like system/non-PII data.
 */
function isObviousNonPII(value: string): boolean {
  // UUIDs (standard format: 8-4-4-4-12 hex)
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) return true;
  // CUID2 format (shorter alphanumeric IDs)
  if (/^[a-z0-9]{24,32}$/.test(value)) return true;
  // Booleans
  if (value === "true" || value === "false") return true;
  // Pure numbers
  if (/^\d+$/.test(value)) return true;
  // URLs (not PII themselves, though they may contain PII in query params)
  // EXCEPT for known PII URL structures like LinkedIn profiles
  if (/^https?:\/\//i.test(value)) {
    // If it's a linkedin profile url, we DO NOT skip it
    if (/(?:www\.)?linkedin\.com\/(?:in|pub|company|school)\/[a-zA-Z0-9_-]+/i.test(value)) {
      return false;
    }
    return true;
  }
  return false;
}

// ─── Enhanced Scanner (All 4 Layers) ─────────────────────────────

/**
 * Enhanced PII scanner that runs all 4 detection layers:
 *
 * Layer 1: Identity Registry — exact string matching from identity.yaml
 * Layer 2: Regex Patterns — email, phone, SSN, credit card, etc.
 * Layer 3: DeBERTa Token Classification — ML-based name/address detection
 * Layer 4: Structural Extraction — JSON field name matching
 *
 * Use this for full PII detection. Use `scanForPII()` for regex-only.
 */
export async function scanForPIIEnhanced(text: string): Promise<PIIMatch[]> {
  if (!text || text.trim().length < 3) return [];

  const allMatches: PIIMatch[] = [];

  // Layer 1: Identity Registry (exact string matching)
  const identityMatches = scanIdentityRegistry(text);
  allMatches.push(...identityMatches);

  // Layer 2: Regex patterns (existing)
  const regexMatches = scanForPII(text);
  allMatches.push(...regexMatches);

  // Layer 3: DeBERTa classification (ML-based, async)
  try {
    const mlMatches = await classifyPII(text);
    for (const match of mlMatches) {
      allMatches.push({
        type: match.category,
        value: match.value,
        start: match.start,
        end: match.end,
      });
    }
  } catch (error) {
    console.warn("[PII Scanner] DeBERTa classification failed, continuing with regex+identity:", error);
  }

  // Deduplicate overlaps
  allMatches.sort((a, b) => a.start - b.start);
  return deduplicateOverlaps(allMatches);
}

/**
 * Scan text against the identity registry for exact string matches.
 * Returns matches sorted by position.
 */
function scanIdentityRegistry(text: string): PIIMatch[] {
  const matches: PIIMatch[] = [];
  const registry = IdentityRegistry.getInstance();
  const exactMatches = registry.getExactMatches();

  for (const { literal, category } of exactMatches) {
    if (!literal || literal.trim().length === 0) continue;

    const piiType = categoryToPIIType(category);
    const escaped = literal.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");

    // Always use word boundaries to prevent partial matches
    // (e.g. "Nimit" should not match within "Nimits")
    const regex = new RegExp(`\\b${escaped}\\b`, "gi");

    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      matches.push({
        type: piiType,
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  return matches;
}

/** Map identity.yaml category names to PIIType. */
function categoryToPIIType(category: string): PIIType {
  const lower = category.toLowerCase();
  if (lower === "name") return "person_name";
  if (lower === "email") return "email";
  if (lower === "phone") return "phone";
  if (lower === "location") return "address";
  if (lower === "gov_id") return "ssn";
  if (lower === "account") return "ssn";
  if (lower === "card") return "credit_card";
  if (lower === "api_key") return "api_key";
  if (lower === "ip_address") return "ip_address";
  if (lower === "vehicle") return "urn";
  if (lower === "project") return "urn";
  return "person_name";
}
