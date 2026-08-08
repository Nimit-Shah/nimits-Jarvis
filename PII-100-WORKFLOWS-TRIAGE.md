# PII 100-Workflow Battery — Triage Report

Status: **Documented only (no code changes)** — decision: *Document only, no code*.

The 100-prompt workflow battery (`src/server/api/routers/nimits-jarvis/agent/pii/__tests__/pii-100-workflows.test.ts`)
probes the full PII pipeline (seed → redact → structured → transport shield → restore) across realistic agent
workflows. It surfaced **13 genuine product findings**: **1 real leak** and **12 over-redaction false positives**.

All 13 are annotated in the test file via the `knownGaps` field (soft-skipped with root-cause reasons), so the
battery is green (`101 passed, 0 failed, 15 soft-skipped`) while the gaps stay visible in the run log.
Injection suite (69/69), pipeline suite (106/106), and typecheck remain green.

---

## 1. GENUINE LEAK — LinkedIn profile URL survives redaction

| | |
|---|---|
| Scenario | `Post-event media roundup` |
| Leaked value | `https://www.linkedin.com/in/priya-sharma` |
| Severity | **HIGH** — personal profile URL reaches the LLM verbatim |

**Root cause:** The plain `url` key is in `SYSTEM_METADATA_KEYS` (pii-tokenizer.ts:453). `deepRedact` therefore
bypasses PII scanning on **any** value under a bare `url` key — including LinkedIn profile URLs, which the
scanner explicitly recognizes as PII elsewhere (`LINKEDIN_URL_RE`, pii-scanner.ts:81). The
`LINKEDIN_URL_KEYS` exception (pii-tokenizer.ts:510) only protects `*_url`-**suffixed** keys
(`profile_url`, `vanity_name`, `publicidentifier`, ...); a bare `url` key is not carved out.

**Fix candidate:** In `deepRedact`'s metadata-bypass branch, if the value matches `LINKEDIN_URL_RE`, do not
bypass — fall through to scanning so the profile URL is tokenized as `linkedin_url`. Equivalently, add `url`
to `LINKEDIN_URL_KEYS` handling for LinkedIn-matching values.

---

## 2. Over-redaction — structural `name`-key heuristic (8 findings)

The key-name heuristic maps `name` → `person_name` (pii-scanner.ts:354). `isFunctionalNameValue`
(pii-scanner.ts:521) skips only: file-extension shapes, digit-bearing values, or containers carrying
`mimeType`/`is_private`/`members`. Doc titles, venue names, company names, board labels, and A/B variant
labels without those markers are therefore treated as person names and tokenized.

| Scenario | Tokenized value |
|---|---|
| Auto-generate PRD | `PRD — Competitive Analysis` |
| Product launch checklist | `Launch Checklist v2` (also `Launch`) |
| A/B test results | `Treatment` |
| User persona builder | `Persona Board` |
| Product health dashboard | `Product Health` |
| Speaker coordination | `Speaker Cards` |
| Venue comparison sheet | `Grand Hall`, `Skyline Loft` |
| Interview prep packs | `Acme` |
| Knowledge base builder | `Knowledge Base` → corrupts `Knowledge Base/Privacy` |

**Fix candidate:** Extend the functional-name guard (or add a DeBERTa post-processor) to skip title-case
multi-word labels that are doc/sheet/folder/board/venue/company names — e.g. require a real person-name
shape (Title Case, 2+ words, no trailing role word like "Cards"/"Board"/"Hall"/"Analysis"), and recognize
Drive `folderId`/`documentId` containers as functional name contexts.

---

## 3. Over-redaction — identity registry hits on substrings (2 findings)

`identity.yaml` lists the standalone first name `Nimit`. `scanIdentityRegistry` (pii-scanner.ts:587) uses
`\b{literal}\b` word boundaries, so the single word `Nimit` matches **inside** larger identifiers.

| Scenario | Tokenized value | Mechanism |
|---|---|---|
| Standup aggregator | `Nimit-Shah` (GitHub `actor`) | `\bnimit\b` matches the prefix; `login` key is exempt but `actor` is not |
| MCP system monitor | `mbp-nimit` hostname (and `user: "nimit"`) | `\bnimit\b` matches inside the hostname |

**Fix candidate:** Require a stronger name context for registry hits — e.g. only match a standalone first
name when followed by a surname (space-separated full-name shape), or exempt `hostname`/`actor`/`author`
system-identifier keys from identity-registry substring matches (mirroring the already-exempt `login`).

---

## 4. Over-redaction — LinkedIn regex matches company pages (1 finding)

| Scenario | Tokenized value |
|---|---|
| Company research bundle | `https://www.linkedin.com/company/acme` |

**Root cause:** `LINKEDIN_URL_RE` (pii-scanner.ts:82) includes `company` and `school` path segments, not
just personal `in`/`pub` profiles. A company page URL is therefore tokenized as `linkedin_url`.

**Fix candidate:** Restrict `LINKEDIN_URL_RE` to `in`/`pub` (person profiles) and let `company`/`school`
pages pass as functional URLs.

---

## Recommendations

1. Fix the leak first (finding #1) — it is the only confidentiality break; the rest are false positives that
   degrade agent functionality (doc titles / usernames / hostnames the LLM needs verbatim).
2. For the over-redaction batch, the highest-leverage fix is the `name`-key guard + identity-registry
   context hardening (findings #2 and #3), which resolve 11 of 12 false positives. The LinkedIn regex
   narrowing (#4) is a one-line change.
3. Re-run all three suites after any fix and re-enable the corresponding `knownGaps` assertions.
