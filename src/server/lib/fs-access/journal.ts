import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Change journal — backups live OUTSIDE the repository, in
 * ~/Library/Application Support/NimitsJarvis/journal/<changeId>/. Never write
 * backups next to the original; a stray .bak inside a project tree is its own
 * kind of damage.
 *
 * GC: lazy (no cron job), fired post-response via setup.ts runPostResponseTasks.
 * Debounced via a sentinel file's mtime (6h), bounded to ~200 deletions per
 * pass, and two-part: (a) applied rows older than 7 days, (b) orphan dirs with
 * no FileChange row at all (chat delete cascades the row, not the filesystem).
 */
const JOURNAL_ROOT = join(
  homedir(),
  "Library",
  "Application Support",
  "NimitsJarvis",
  "journal",
);

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const GC_DEBOUNCE_MS = 6 * 60 * 60 * 1000;
const GC_MAX_DELETIONS = 200;
const GC_SENTINEL = ".last-gc";

export function journalDirFor(changeId: string): string {
  return join(JOURNAL_ROOT, changeId);
}

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Copy the original file into the journal before any mutation. */
export async function backupOriginal(changeId: string, target: string): Promise<{ backupPath: string; bytesBefore: number; sha256Before: string } | null> {
  try {
    const st = await stat(target);
    if (!st.isFile()) return null;
    const dir = journalDirFor(changeId);
    await mkdir(dir, { recursive: true });
    const dest = join(dir, "original");
    await cp(target, dest);
    const content = await readFile(dest);
    return {
      backupPath: dest,
      bytesBefore: content.length,
      sha256Before: sha256(content),
    };
  } catch {
    // Original doesn't exist (create op) — nothing to back up
    return null;
  }
}

/** Restore a journal copy over the target (undo). Byte-for-byte. */
export async function restoreFromJournal(changeId: string, target: string): Promise<{ bytesRestored: number; sha256: string }> {
  const src = join(journalDirFor(changeId), "original");
  const content = await readFile(src); // throws if journal copy is gone
  const { atomicWrite } = await import("./atomic-write");
  await atomicWrite(target, content);
  return { bytesRestored: content.length, sha256: sha256(content) };
}

let gcRunning = false;

/**
 * Debounced, bounded, fire-and-forget GC. Call AFTER the response completes
 * (runPostResponseTasks) — never in front of an Approve click.
 */
export async function scheduleJournalGc(): Promise<void> {
  if (gcRunning) return;
  gcRunning = true;
  void (async () => {
    try {
      const { stat: st, utimes } = await import("node:fs/promises");
      const sentinel = join(JOURNAL_ROOT, GC_SENTINEL);
      try {
        const s = await st(sentinel);
        if (Date.now() - s.mtimeMs < GC_DEBOUNCE_MS) return;
      } catch {
        // no sentinel yet — proceed
      }
      await mkdir(JOURNAL_ROOT, { recursive: true });
      await utimes(sentinel, new Date(), new Date());

      const { db } = await import("~/server/clients/db");
      const cutoff = new Date(Date.now() - RETENTION_MS);

      const dirs = await readdir(JOURNAL_ROOT);
      let deleted = 0;

      // (a) rows applied (or terminal) older than retention
      const expired = await db.fileChange.findMany({
        where: {
          OR: [
            { appliedAt: { lt: cutoff } },
            { status: { in: ["rejected", "failed", "stale"] }, createdAt: { lt: cutoff } },
          ],
        },
        select: { id: true },
        take: GC_MAX_DELETIONS,
      });
      for (const row of expired) {
        if (deleted >= GC_MAX_DELETIONS) break;
        await rm(join(JOURNAL_ROOT, row.id), { recursive: true, force: true });
        deleted++;
      }

      // (b) orphan dirs — no FileChange row at all (chat delete cascades the row)
      const remaining = dirs.filter((d) => d !== GC_SENTINEL);
      for (const dir of remaining) {
        if (deleted >= GC_MAX_DELETIONS) break;
        const row = await db.fileChange.findUnique({ where: { id: dir }, select: { id: true } });
        if (!row) {
          await rm(join(JOURNAL_ROOT, dir), { recursive: true, force: true });
          deleted++;
        }
      }
    } catch (err) {
      console.warn("[journal] gc failed (non-fatal):", err);
    } finally {
      gcRunning = false;
    }
  })();
}
