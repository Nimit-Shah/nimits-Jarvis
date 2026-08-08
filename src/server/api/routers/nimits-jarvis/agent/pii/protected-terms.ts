/**
 * Protected Terms — a config-driven allowlist of values that must NEVER be
 * redacted by the PII shield.
 *
 * Some terms look like person names / identifiers to the scanner (DeBERTa ML
 * classifier, identity registry) but are actually stable product/agent names
 * or functional identifiers that:
 *   - would break functionality if tokenized (agent name in the system prompt,
 *     project/product names referenced in prompts and tool calls), and
 *   - cause partial-span corruption when DeBERTa matches only a substring
 *     (e.g. "Jarvis" → "[CLAW_PERSON_NAME_XXXX]vis").
 *
 * Values are matched case-insensitively and by whole-word to avoid clobbering
 * legitimate PII that merely shares a prefix (e.g. protecting "Nimit" would
 * wrongly skip the user's real name — so we protect the full product name
 * "Nimits-Jarvis", not "Nimit").
 *
 * The allowlist is seeded from a `protected_terms` section in `identity.yaml`
 * (local-only) and falls back to sensible built-in defaults so it works out of
 * the box.
 */

import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";

/** Default terms that are safe to preserve. Lowercased for comparison. */
const DEFAULT_PROTECTED_TERMS = [
  // Agent identity
  "jarvis",
  "nimits-jarvis",
  "nimits jarvis",
  // Product / project names
  "trustclaw",
  "project aurora",
  // Agent platform / model vendors — these are product names the user's agent
  // legitimately references in prompts, tool calls, and packages. DeBERTa
  // frequently misclassifies them as person names.
  "composio",
  "claude",
  "gpt",
  "openai",
  "anthropic",
  "openrouter",
];

/**
 * Matches `term` as a whole word within `value` (case-insensitive).
 * Uses lookarounds so we never protect a substring of a larger identifier.
 */
function containsWholeWord(value: string, term: string): boolean {
  // Escape regex special chars (terms are plain strings)
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(value);
}

class ProtectedTerms {
  private terms: Set<string> = new Set(
    DEFAULT_PROTECTED_TERMS.map((t) => t.toLowerCase()),
  );

  constructor() {
    this.loadFromConfig();
  }

  private loadFromConfig(): void {
    try {
      const configPath = path.resolve(process.cwd(), "identity.yaml");
      if (!fs.existsSync(configPath)) return;
      const config = yaml.load(fs.readFileSync(configPath, "utf8")) as {
        protected_terms?: string[];
      };
      const extra = config?.protected_terms;
      if (Array.isArray(extra)) {
        for (const term of extra) {
          if (typeof term === "string" && term.trim()) {
            this.terms.add(term.trim().toLowerCase());
          }
        }
      }
    } catch (err) {
      console.warn("[ProtectedTerms] Error reading identity.yaml:", err);
    }
  }

  /**
   * True if `value` (or any whole word it contains) is a protected term.
   * Any single whole-word occurrence protects the entire value — this means a
   * value that mentions "Jarvis" is never tokenized, which is the desired
   * behavior for agent/product names embedded in prompts.
   */
  isProtected(value: string): boolean {
    if (!value) return false;
    const lower = value.toLowerCase();
    if (this.terms.has(lower)) return true;
    for (const term of this.terms) {
      if (containsWholeWord(lower, term)) return true;
    }
    return false;
  }
}

const instance = new ProtectedTerms();

/** True if `value` should never be redacted. */
export function isProtectedTerm(value: string): boolean {
  return instance.isProtected(value);
}
