#!/usr/bin/env node
/**
 * One-off backfill: flip the global default timezone from UTC to IST
 * (Asia/Kolkata) on rows that still carry the old default.
 *
 * The app now defaults every user + every cron job to Asia/Kolkata (see
 * prisma/schema.prisma and src/lib/timezone.ts). Rows created before this
 * change stored "UTC" (the old default), so this script updates them so all
 * chats, crons, and timestamps resolve to IST going forward.
 *
 * Only rows whose timezone is still exactly "UTC" are touched — any explicitly
 * chosen non-UTC timezone is left alone. There is no timezone picker in the UI,
 * so "UTC" here unambiguously means "the old default", never a user choice.
 *
 * SAFETY: defaults to DRY-RUN. Pass `--apply` to actually write to the database.
 *
 *   node scripts/backfill-timezone.cjs           # dry run, prints what would change
 *   node scripts/backfill-timezone.cjs --apply   # write the changes
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");
const IST = "Asia/Kolkata";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Aborting.");
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  await client.connect();

  try {
    console.log(`timezone backfill -> ${IST} (${APPLY ? "APPLY" : "DRY-RUN"})`);
    console.log("");

    const results = [];

    const userRes = await client.query(
      `SELECT id FROM "user" WHERE timezone = 'UTC'`,
    );
    results.push({ table: "user", quotedTable: '"user"', count: userRes.rowCount });

    const cronRes = await client.query(
      `SELECT id FROM composio_claw_cron_job WHERE timezone = 'UTC'`,
    );
    results.push({ table: "composio_claw_cron_job", quotedTable: "composio_claw_cron_job", count: cronRes.rowCount });

    for (const r of results) {
      console.log(`  ${r.table.padEnd(24)} ${r.count ?? 0} row(s) to update`);
    }

    if (!APPLY) {
      console.log("");
      console.log("DRY-RUN — nothing changed. Re-run with --apply to write.");
      return;
    }

    for (const r of results) {
      if ((r.count ?? 0) > 0) {
        await client.query(
          `UPDATE ${r.quotedTable} SET timezone = $1 WHERE timezone = 'UTC'`,
          [IST],
        );
      }
    }

    console.log("");
    console.log("Applied.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});