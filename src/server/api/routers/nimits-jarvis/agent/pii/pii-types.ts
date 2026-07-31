/**
 * PII (Personally Identifiable Information) type definitions.
 *
 * Used by the scanner, tokenizer, and vault to classify detected PII
 * entities and manage the redaction/restoration lifecycle.
 */

/** Categories of PII that the scanner can detect. */
export type PIIType =
  | "email"
  | "phone"
  | "credit_card"
  | "ssn"
  | "ip_address"
  | "address"
  | "person_name"
  | "api_key"
  | "urn"
  | "linkedin_url"
  | "ticket_id"
  | "reference_id"
  | "account_suffix";

/** A single PII entity detected in text. */
export interface PIIMatch {
  /** The category of PII. */
  type: PIIType;
  /** The original value as found in the source text. */
  value: string;
  /** Start index in the source text (inclusive). */
  start: number;
  /** End index in the source text (exclusive). */
  end: number;
}

/**
 * Maps a placeholder token (e.g. `[EMAIL_1]`) back to the original value.
 * Kept in memory only — never persisted or logged.
 */
export interface PIIMapping {
  /** The token used in redacted text, e.g. `[EMAIL_1]`. */
  token: string;
  /** The original PII value this token replaces. */
  original: string;
  /** The PII category. */
  type: PIIType;
}

/** Audit statistics from a PIIVault instance. */
export interface PIIVaultStats {
  /** Total number of unique PII entities redacted. */
  totalRedacted: number;
  /** Breakdown by PII type. */
  byType: Partial<Record<PIIType, number>>;
}
