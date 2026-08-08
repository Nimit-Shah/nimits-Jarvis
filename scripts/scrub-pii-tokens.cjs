#!/usr/bin/env node
/**
 * One-off scrub for orphaned PII tokens persisted before the memory-flush fix.
 *
 * Background: the per-request PIIVault (src/server/api/routers/nimits-jarvis/agent/
 * pii/pii-tokenizer.ts) never persists its token→value mapping. Some requests could
 * previously persist a token like `[CLAW_PERSON_NAME_542F]` or
 * `CLAW_EMAIL_FE1A@trustclaw.anon` into the durable store (e.g. runMemoryFlush saved
 * redacted context verbatim). On a later request those tokens can never be inverted,
 * so restore() lets them pass through and they leak into user-facing output.
 *
 * This script scans the durable stores that can hold such tokens and replaces
 * every residual token placeholder with "[redacted]". It does NOT recover the
 * real values (impossible — the mapping is gone); it only prevents them from
 * leaking further.
 *
 * SAFETY: defaults to DRY-RUN. Pass `--apply` to actually write to the database.
 *
 *   node scripts/scrub-pii-tokens.cjs            # dry run, prints what would change
 *   node scripts/scrub-pii-tokens.cjs --apply    # write the changes
 *
 * Note on search quality: rows in composio_claw_memory are scrubbed in place without
 * recomputing their embedding vector, so vector-similarity hits on exactly those rows
 * may degrade slightly. This is the safe trade-off — no data leak — and only affects
 * rows that already contained a token.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { Client } = require("pg");

// Same token shapes as src/.../pii/pii-tokenizer.ts (makeToken) and brands.ts
// RESIDUAL_TOKEN_RE. Keep in sync if the token format changes. Email-domain
// alternatives come FIRST so `CLAW_EMAIL_XXXX@trustclaw.anon` is matched whole
// and never split by the generic `CLAW_[A-Z_]+_...` branch (which would leave
// a dangling `@trustclaw.anon`).
const TOKEN_RE =
  /(?:CLAW_EMAIL_[A-F0-9]{4}@trustclaw\.anon|\[CLAW_EMAIL_[A-F0-9]{4}\]@trustclaw\.anon|\[CLAW_[A-Z_]+_[A-F0-9]{4}\]|CLAW_[A-Z_]+_[A-F0-9]{4})/g;
const SQL_MATCH = "CLAW_EMAIL_[A-F0-9]{4}@trustclaw\\.anon|CLAW_[A-Z_]+_[A-F0-9]{4}";
const REPLACEMENT = "[redacted]";

const APPLY = process.argv.includes("--apply");

/** @param {string} text */
function scrubText(text) {
  if (!text || !TOKEN_RE.test(text)) return null;
  TOKEN_RE.lastIndex = 0;
  return text.replace(TOKEN_RE, REPLACEMENT);
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(`MODE: ${APPLY ? "APPLY" : "DRY-RUN"} (pass --apply to write)`);

  // ── Table 1: composio_claw_memory (content is plain text) ─────────────────
  {
    const { rows } = await client.query(
      `SELECT id, content FROM composio_claw_memory WHERE content ~ $1`,
      [SQL_MATCH],
    );
    let fixable = 0;
    for (const row of rows) {
      const fixed = scrubText(row.content);
      if (fixed === null) continue;
      fixable++;
      if (APPLY) {
        await client.query(
          `UPDATE composio_claw_memory SET content = $1 WHERE id = $2`,
          [fixed, row.id],
        );
      }
    }
    console.log(
      `[composio_claw_memory] ${rows.length} row(s) matched token pattern, ` +
        `${fixable} contain a scrub-able token${APPLY ? " (updated)" : ""}`,
    );
  }

  // ── Table 2: composio_claw_message (content is JSON) ───────────────────────
  // Tokens are plain-ASCII substrings inside JSON string values, so replacing them
  // with "[redacted]" cannot invalidate the JSON document.
  {
    const { rows } = await client.query(
      `SELECT id, content::text AS content FROM composio_claw_message WHERE content::text ~ $1`,
      [SQL_MATCH],
    );
    let fixable = 0;
    for (const row of rows) {
      const fixed = scrubText(row.content);
      if (fixed === null) continue;
      fixable++;
      if (APPLY) {
        await client.query(
          `UPDATE composio_claw_message SET content = $1::jsonb WHERE id = $2`,
          [fixed, row.id],
        );
      }
    }
    console.log(
      `[composio_claw_message] ${rows.length} row(s) matched token pattern, ` +
        `${fixable} contain a scrub-able token${APPLY ? " (updated)" : ""}`,
    );
  }

  // ── Table 3: composio_claw_chat.lastCompactionSummary (plain text) ─────────
  // Compaction summaries are restored before persistence (run-compaction.ts),
  // but a summarizer that echoed an orphan token could still leave one here.
  // Replaying this summary into the next turn's context re-exposes it, so it
  // must be scrubbed like the other durable stores.
  {
    const { rows } = await client.query(
      `SELECT id, "lastCompactionSummary" AS content FROM composio_claw_chat WHERE "lastCompactionSummary" ~ $1`,
      [SQL_MATCH],
    );
    let fixable = 0;
    for (const row of rows) {
      const fixed = scrubText(row.content);
      if (fixed === null) continue;
      fixable++;
      if (APPLY) {
        await client.query(
          `UPDATE composio_claw_chat SET "lastCompactionSummary" = $1 WHERE id = $2`,
          [fixed, row.id],
        );
      }
    }
    console.log(
      `[composio_claw_chat.lastCompactionSummary] ${rows.length} row(s) matched token pattern, ` +
        `${fixable} contain a scrub-able token${APPLY ? " (updated)" : ""}`,
    );
  }

  await client.end();
  console.log("Scrub complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
