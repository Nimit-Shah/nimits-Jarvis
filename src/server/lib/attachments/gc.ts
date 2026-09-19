import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { db } from "~/server/clients/db";
import { getAttachmentsRoot } from "./constants";

const GC_DEBOUNCE_MS = 6 * 60 * 60 * 1000;
const GC_SENTINEL = ".last-gc";
const REMOVED_RETENTION_MS = 24 * 60 * 60 * 1000;
const COMPOSER_RETENTION_MS = 6 * 60 * 60 * 1000;
const GC_MAX_DELETIONS = 200;

/**
 * Orphan sweep for attachment bytes (mirrors journal GC discipline):
 * debounced via sentinel mtime, bounded per pass. Removes (a) rows with
 * status removed older than 24h, (b) composer-stage rows (messageId null)
 * older than 6h, (c) directories with no corresponding row (e.g. chat
 * deleted through a path that bypassed the app delete route). Never throws.
 */
export async function sweepAttachments(): Promise<void> {
  try {
    const root = getAttachmentsRoot();
    const sentinel = join(root, GC_SENTINEL);
    try {
      const st = await stat(sentinel);
      if (Date.now() - st.mtimeMs < GC_DEBOUNCE_MS) return;
    } catch {
      // No sentinel yet — proceed, then write it.
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(sentinel, String(Date.now())).catch(() => undefined);

    let deletions = 0;
    const now = Date.now();
    const staleRemoved = await db.messageAttachment.findMany({
      where: { status: "removed", createdAt: { lt: new Date(now - REMOVED_RETENTION_MS) } },
      select: { id: true, instanceId: true, chatId: true },
      take: GC_MAX_DELETIONS,
    });
    const staleComposer = await db.messageAttachment.findMany({
      where: { messageId: null, status: { not: "removed" }, createdAt: { lt: new Date(now - COMPOSER_RETENTION_MS) } },
      select: { id: true, instanceId: true, chatId: true },
      take: GC_MAX_DELETIONS,
    });
    for (const row of [...staleRemoved, ...staleComposer]) {
      if (deletions >= GC_MAX_DELETIONS) break;
      await rm(join(root, row.instanceId, row.chatId, row.id), { recursive: true, force: true }).catch(() => undefined);
      await db.messageAttachment.delete({ where: { id: row.id } }).catch(() => undefined);
      deletions++;
    }

    // Orphan dirs: <instanceId>/<chatId>/<attachmentId> with no row.
    if (deletions < GC_MAX_DELETIONS) {
      const instances = await readdir(root).catch(() => [] as string[]);
      for (const inst of instances) {
        if (deletions >= GC_MAX_DELETIONS) break;
        if (inst.startsWith(".")) continue;
        const chats = await readdir(join(root, inst)).catch(() => [] as string[]);
        for (const ch of chats) {
          if (deletions >= GC_MAX_DELETIONS) break;
          if (ch.startsWith(".")) continue;
          const dirs = await readdir(join(root, inst, ch)).catch(() => [] as string[]);
          for (const dir of dirs) {
            if (deletions >= GC_MAX_DELETIONS) break;
            if (dir.startsWith(".")) continue;
            const row = await db.messageAttachment.findUnique({
              where: { id: dir },
              select: { id: true },
            }).catch(() => null);
            if (!row) {
              await rm(join(root, inst, ch, dir), { recursive: true, force: true }).catch(() => undefined);
              deletions++;
            }
          }
          // Prune chat dirs left empty after orphan removal (best-effort).
          const remaining = await readdir(join(root, inst, ch)).catch(() => null);
          if (remaining?.length === 0) {
            await rm(join(root, inst, ch)).catch(() => undefined);
          }
        }
      }
    }
  } catch {
    // GC is best-effort by design.
  }
}
