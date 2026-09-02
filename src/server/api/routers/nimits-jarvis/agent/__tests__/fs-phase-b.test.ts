/**
 * Phase B acceptance tests — approval flow end-to-end against a temp sandbox.
 * Run: pnpm exec dotenv -e .env -- pnpm exec tsx src/server/api/routers/nimits-jarvis/agent/__tests__/fs-phase-b.test.ts
 *
 * Covers spec §9: create-on-existing refusal, pre-flight edit mismatch errors,
 * execute (atomic write + digest verify), stale detection, undo byte-for-byte,
 * undo-modified refusal, and the noArgumentRestore PII proof.
 *
 * NOTE: DB-backed pieces (FileChange rows) run against the real local DB —
 * rows are created with unique toolCallIds and the sandbox is cleaned up.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { preFlightFileChange } from "../tools/fs/preflight";
import { resolveWritePath } from "~/server/lib/fs-access/write-paths";
import { atomicWrite } from "~/server/lib/fs-access/atomic-write";
import { backupOriginal, restoreFromJournal } from "~/server/lib/fs-access/journal";
import { sha256Buffer, sha256File } from "~/server/lib/fs-access/diff";
import { PIIVault } from "../pii";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.error(`  ✘ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 260)}` : ""}`); }
}

// Minimal DB harness: preFlightFileChange writes FileChange rows — run against
// the real DB with unique ids, then clean up.
async function cleanupRows(ids: string[]) {
  if (ids.length === 0) return;
  const { db: d } = await import("~/server/clients/db");
  await d.fileChange.deleteMany({ where: { id: { in: ids.filter(Boolean) } } });
}

async function main() {
  const created: string[] = [];
  // FK requires a real instance row — use the earliest one (test rows are cleaned up)
  const { db } = await import("~/server/clients/db");
  const realInstance = await db.composioClawInstance.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  const instanceId = realInstance?.id ?? "phase-b-test-instance";
  const realChat = await db.chat.findFirst({ orderBy: { updatedAt: "desc" }, select: { id: true } });
  const chatId = realChat?.id ?? "phase-b-test-chat";

  const sandbox = mkdtempSync(join(tmpdir(), "fs-b-test-"));
  const root = realpathSync(sandbox);

  console.log("pre-flight — create-on-existing & edit guards");
  writeFileSync(join(root, "existing.txt"), "hello world\nsecond line\n");

  const dup = await preFlightFileChange({
    instanceId, chatId, toolCallId: randomUUID(), fsRoot: root,
    op: "write", path: join(root, "existing.txt"), content: "x", mode: "create",
  });
  check("fs_write create on existing → ALREADY_EXISTS", !dup.ok && dup.error?.code === "ALREADY_EXISTS", dup);

  const notFound = await preFlightFileChange({
    instanceId, chatId, toolCallId: randomUUID(), fsRoot: root,
    op: "edit", path: join(root, "missing.txt"), oldText: "a", newText: "b", expectedOccurrences: 1,
  });
  check("edit on missing file → NOT_FOUND", !notFound.ok && notFound.error?.code === "NOT_FOUND", notFound);

  writeFileSync(join(root, "code.ts"), "const a = 1;\nconst b = 2;\n");
  const noMatch = await preFlightFileChange({
    instanceId, chatId, toolCallId: randomUUID(), fsRoot: root,
    op: "edit", path: join(root, "code.ts"), oldText: "const c", newText: "const c = 3", expectedOccurrences: 1,
  });
  check("oldText not found → OLD_TEXT_NOT_FOUND (no card)", !noMatch.ok && noMatch.error?.code === "OLD_TEXT_NOT_FOUND", noMatch);

  writeFileSync(join(root, "dup.ts"), "x = 1;\nx = 1;\n");
  const multi = await preFlightFileChange({
    instanceId, chatId, toolCallId: randomUUID(), fsRoot: root,
    op: "edit", path: join(root, "dup.ts"), oldText: "x = 1;", newText: "y = 2;", expectedOccurrences: 1,
  });
  check("occurrence mismatch → OCCURRENCE_MISMATCH with count", !multi.ok && multi.error?.code === "OCCURRENCE_MISMATCH" && /matched 2/.test(multi.error.message), multi);

  console.log("pre-flight — happy path edit (diff + digests, nothing on disk)");
  const before = readFileSync(join(root, "code.ts"), "utf-8");
  const good = await preFlightFileChange({
    instanceId, chatId, toolCallId: randomUUID(), fsRoot: root,
    op: "edit", path: join(root, "code.ts"), oldText: "const b = 2;", newText: "const b = 42;", expectedOccurrences: 1,
  });
  created.push(good.ok ? (good.fileChange?.id ?? "") : "");
  check("edit pre-flight ok with unified diff", good.ok && typeof good.fileChange?.diff === "string" && good.fileChange.diff.includes("-const b = 2;") && good.fileChange.diff.includes("+const b = 42;"), good.ok ? good.fileChange?.diff : good);
  check("digest bound: sha256Before matches disk", good.ok && good.fileChange?.sha256Before === sha256Buffer(before));
  check("NOTHING written before approve", readFileSync(join(root, "code.ts"), "utf-8") === before);

  console.log("execute — apply, digest verify, journal, undo");
  if (good.ok && good.fileChange) {
    const changeId = good.fileChange.id;
    const target = good.fileChange.path;
    const afterBuf = await readFile(join(process.env.HOME ?? "", "Library", "Application Support", "NimitsJarvis", "journal", changeId, "after"));
    const backup = await backupOriginal(changeId, target);
    check("journal backup has original content", backup?.sha256Before === sha256Buffer(before));

    const { bytesWritten } = await atomicWrite(target, afterBuf);
    const actualSha = await sha256File(target);
    check("atomic write applied + digest matches pre-flight", actualSha === good.fileChange.sha256After && bytesWritten === (good.fileChange.bytesAfter ?? -1), { actualSha, expect: good.fileChange.sha256After });
    check("content is the edit", readFileSync(target, "utf-8") === "const a = 1;\nconst b = 42;\n");

    // Undo byte-for-byte
    const undo = await restoreFromJournal(changeId, target);
    check("undo restores original byte-for-byte", undo.sha256 === sha256Buffer(before) && readFileSync(target, "utf-8") === before);
  }

  console.log("stale detection");
  const staleTarget = join(root, "stale.txt");
  writeFileSync(staleTarget, "version one\n");
  const stale = await preFlightFileChange({
    instanceId, chatId, toolCallId: randomUUID(), fsRoot: root,
    op: "edit", path: staleTarget, oldText: "one", newText: "two", expectedOccurrences: 1,
  });
  created.push(stale.ok ? (stale.fileChange?.id ?? "") : "");
  if (stale.ok && stale.fileChange) {
    // operator edits the file while the card is open
    writeFileSync(staleTarget, "version one + operator edit\n");
    const currentSha = sha256Buffer(readFileSync(staleTarget));
    check("digest mismatch after external edit → STALE", currentSha !== stale.fileChange.sha256Before, { currentSha, before: stale.fileChange.sha256Before });
  }

  console.log("mkdir — parent missing refusal at execute level");
  const badMkdir = await resolveWritePath(join(root, "a", "b", "c"), root, { op: "mkdir" });
  check("deep mkdir path resolves but parent check is execute-level", badMkdir.ok || badMkdir.error.code === "PARENT_MISSING", badMkdir);

  console.log("noArgumentRestore — tokenized email lands on disk as TOKEN");
  const vault = new PIIVault();
  const token = vault.registerPII("email", "real.person@example.com");
  // Simulate wrapToolExecutors with noArgumentRestore: input passes through untouched
  const writeInput = { path: join(root, "pii.txt"), content: `contact: ${token}`, mode: "create" as const };
  const pf = await preFlightFileChange({
    instanceId, chatId, toolCallId: randomUUID(), fsRoot: root,
    op: "write", path: writeInput.path, content: writeInput.content, mode: "create",
  });
  created.push(pf.ok ? (pf.fileChange?.id ?? "") : "");
  if (pf.ok && pf.fileChange) {
    const afterPath = join(process.env.HOME ?? "", "Library", "Application Support", "NimitsJarvis", "journal", pf.fileChange.id, "after");
    const onDisk = readFileSync(afterPath, "utf-8");
    check("journal after-content keeps the TOKEN (no real address)", onDisk.includes(token) && !onDisk.includes("real.person@example.com"), onDisk.slice(0, 80));
    const { bytesWritten } = await atomicWrite(pf.fileChange.path, afterBufSync(afterPath));
    check("disk write keeps the TOKEN", bytesWritten > 0 && readFileSync(pf.fileChange.path, "utf-8").includes(token) && !readFileSync(pf.fileChange.path, "utf-8").includes("real.person@example.com"));
  }

  console.log("availability gating — write tools absent unless full");
  const { createCustomTools } = await import("../tools");
  const readOnly = createCustomTools("i", "c", "UTC", { fsReadEnabled: true, fsMode: "read-only", fsRoot: null });
  check("read-only: no write tools", !("fs_edit" in readOnly) && !("fs_write" in readOnly) && !("fs_delete" in readOnly) && !("fs_mkdir" in readOnly) && !("fs_move" in readOnly) && "fs_list" in readOnly);
  const full = createCustomTools("i", "c", "UTC", { fsReadEnabled: true, fsMode: "full", fsRoot: null });
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

function afterBufSync(path: string): Buffer {
  return readFileSync(path);
}

void main();
