/**
 * Phase B acceptance tests — B1 auto-write audit-log path end-to-end against a
 * temp sandbox. Run: pnpm exec dotenv -e .env -- pnpm exec tsx src/server/api/routers/nimits-jarvis/agent/__tests__/fs-phase-b.test.ts
 *
 * Covers spec §9 + B1: write tools create FileChange rows directly with
 * status="applied" (no card, no pending state), backup happens before the
 * atomic rename so undo works, change-budget caps writes per message, and a
 * tokenized email is NEVER written to disk (noArgumentRestore proof).
 *
 * NOTE: DB-backed pieces (FileChange rows) run against the real local DB —
 * rows are created with unique toolCallIds and the sandbox is cleaned up.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { restoreFromJournal } from "~/server/lib/fs-access/journal";
import { sha256Buffer } from "~/server/lib/fs-access/diff";
import { PIIVault } from "../pii";
import { createCustomTools, type FsToolOptions } from "../tools";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.error(`  ✘ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 260)}` : ""}`); }
}

// Minimal DB harness: write tools journal FileChange rows — run against the
// real DB with unique ids, then clean up.
async function cleanupRows(ids: string[]) {
  if (ids.length === 0) return;
  const { db: d } = await import("~/server/clients/db");
  await d.fileChange.deleteMany({ where: { id: { in: ids.filter(Boolean) } } });
}

function fullOpts(root: string, budget: number): FsToolOptions {
  return {
    fsReadEnabled: true,
    fsMode: "full",
    fsRoot: root,
    instanceId: "b1-test-instance",
    chatId: "b1-test-chat",
    changeBudget: { remaining: budget },
  };
}

async function main() {
  const created: string[] = [];
  const { db } = await import("~/server/clients/db");

  const sandbox = mkdtempSync(join(tmpdir(), "fs-b-test-"));
  const root = realpathSync(sandbox);

  async function rowFor(toolCallId: string) {
    return db.fileChange.findUnique({ where: { toolCallId } });
  }

  console.log("B1 auto-write: journaling + audit log (status applied)");
  writeFileSync(join(root, "code.ts"), "const a = 1;\nconst b = 2;\n");

  const tools = createCustomTools("b1-test-instance", "b1-test-chat", "UTC", fullOpts(root, 5));
  const editCall = randomUUID();
  const edit = await (tools as any).fs_edit.execute!(
    { path: join(root, "code.ts"), oldText: "const b = 2;", newText: "const b = 42;", expectedOccurrences: 1 },
    { toolCallId: editCall },
  );
  check("fs_edit auto-applies (no card)", edit.status === "applied", edit);
  const editRow = await rowFor(editCall);
  created.push(editRow?.id ?? "");
  check("edit journaled as applied", editRow?.status === "applied" && editRow?.op === "edit", editRow);
  check("diff bound to row", typeof editRow?.diff === "string" && editRow.diff.includes("-const b = 2;") && editRow.diff.includes("+const b = 42;"), editRow?.diff);
  // "const a = 1;\nconst b = 2;\n" = 26 bytes; after edit: "const b = 42;\n" → 27
  check("digests + bytes recorded", editRow?.bytesBefore === 26 && editRow?.bytesAfter === 27 && typeof editRow?.sha256Before === "string", { b: editRow?.bytesBefore, a: editRow?.bytesAfter });

  const wCall = randomUUID();
  const w = await (tools as any).fs_write.execute!(
    { path: join(root, "created.ts"), content: "export const x = 1;\n", mode: "create" },
    { toolCallId: wCall },
  );
  check("fs_write create auto-applied", w.status === "applied", w);
  const wRow = await rowFor(wCall);
  created.push(wRow?.id ?? "");
  check("create row: applied, no before digest", wRow?.status === "applied" && wRow?.sha256Before === null && wRow?.bytesBefore === null, wRow);

  // Delete → to Trash, journaled
  writeFileSync(join(root, "toDelete.txt"), "delete me");
  const dCall = randomUUID();
  const del = await (tools as any).fs_delete.execute!({ path: join(root, "toDelete.txt") }, { toolCallId: dCall });
  check("fs_delete moved to Trash (recoverable)", del.status === "applied" && /\.Trash/.test(del.trashedTo), del);
  const dRow = await rowFor(dCall);
  created.push(dRow?.id ?? "");
  check("delete row: applied, before recorded", dRow?.status === "applied" && dRow?.sha256Before !== null && dRow?.diff !== null, dRow);

  console.log("undo — byte-for-byte via journal");
  if (editRow) {
    const beforeText = readFileSync(join(root, "code.ts"), "utf-8");
    const undo = await restoreFromJournal(editRow.id, editRow.path);
    check("undo restores original byte-for-byte", undo.sha256 === sha256Buffer("const a = 1;\nconst b = 2;\n") && readFileSync(join(root, "code.ts"), "utf-8") === "const a = 1;\nconst b = 2;\n", { beforeText, undo });
  }

  console.log("change budget — blast-radius cap per message");
  const budgeted = createCustomTools("b1-test-instance", "b1-test-chat", "UTC", fullOpts(root, 1));
  writeFileSync(join(root, "one.ts"), "x = 1;\n");
  writeFileSync(join(root, "two.ts"), "y = 1;\n");
  const one = await (budgeted as any).fs_edit.execute!({ path: join(root, "one.ts"), oldText: "x = 1;", newText: "x = 2;", expectedOccurrences: 1 }, { toolCallId: randomUUID() });
  check("first change applies within budget", one.status === "applied", one);
  const two = await (budgeted as any).fs_edit.execute!({ path: join(root, "two.ts"), oldText: "y = 1;", newText: "y = 2;", expectedOccurrences: 1 }, { toolCallId: randomUUID() });
  check("second change refused (budget exhausted)", two.status === undefined && two.error?.code === "CHANGE_BUDGET_EXCEEDED" && /per message/.test(two.error.message), two);
  check("budget refusal leaves file untouched", readFileSync(join(root, "two.ts"), "utf-8") === "y = 1;\n");

  console.log("noArgumentRestore — tokenized email never lands on disk as real");
  const vault = new PIIVault();
  const token = vault.registerPII("email", "real.person@example.com");
  const piiCall = randomUUID();
  const piiWrite = await (tools as any).fs_write.execute!(
    { path: join(root, "pii.txt"), content: `contact: ${token}`, mode: "create" },
    { toolCallId: piiCall },
  );
  check("fs_write auto-applies tokenized content", piiWrite.status === "applied", piiWrite);
  const onDiskPii = readFileSync(join(root, "pii.txt"), "utf-8");
  check("journal + disk keep the TOKEN (no real address)", onDiskPii.includes(token) && !onDiskPii.includes("real.person@example.com"), onDiskPii.slice(0, 80));
  const piiRow = await rowFor(piiCall);
  created.push(piiRow?.id ?? "");

  console.log("availability gating — write tools absent unless full");
  const readOnly = createCustomTools("i", "c", "UTC", { fsReadEnabled: true, fsMode: "read-only", fsRoot: null, instanceId: "i", chatId: "c", changeBudget: { remaining: 0 } });
  check("read-only: no write tools", !("fs_edit" in readOnly) && !("fs_write" in readOnly) && !("fs_delete" in readOnly) && !("fs_mkdir" in readOnly) && !("fs_move" in readOnly) && "fs_list" in readOnly);
  const full = createCustomTools("i", "c", "UTC", { fsReadEnabled: true, fsMode: "full", fsRoot: null, instanceId: "i", chatId: "c", changeBudget: { remaining: 0 } });
  check(
    "full: write tools present and auto-execute (B1)",
    "fs_edit" in full &&
      "fs_write" in full &&
      "fs_delete" in full &&
      "fs_mkdir" in full &&
      "fs_move" in full &&
      "execute" in (full as any).fs_edit &&
      typeof (full as any).fs_edit.execute === "function",
  );

  rmSync(sandbox, { recursive: true, force: true });
  await cleanupRows(created);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();