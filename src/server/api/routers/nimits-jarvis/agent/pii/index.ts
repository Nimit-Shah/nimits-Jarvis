/**
 * PII (Personally Identifiable Information) encryption layer.
 *
 * Provides server-side detection, tokenization, and restoration of PII
 * to prevent sensitive data from reaching external LLMs.
 *
 * Usage:
 *   import { PIIVault } from "./pii";
 *
 *   const vault = new PIIVault();
 *   const safe = vault.redact("Email me at john@example.com");
 *   // safe === "Email me at [EMAIL_1]"
 *   const restored = vault.restore("[EMAIL_1] is your contact");
 *   // restored === "john@example.com is your contact"
 */

export { PIIVault, containsTokenPattern, isTokenString } from "./pii-tokenizer";
export { PIITransportShield } from "./pii-transport-shield";
export { scanForPII, extractStructuredPII } from "./pii-scanner";
export type {
  PIIType,
  PIIMatch,
  PIIMapping,
  PIIVaultStats,
} from "./pii-types";
