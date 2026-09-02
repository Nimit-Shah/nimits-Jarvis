import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { readFile } from "node:fs/promises";
import { executeFileChangeInput } from "./executeFileChange.schema";
import { assertInstanceOwnedByUser, withInstanceLock, db } from "./file-change-utils";
import { getInstanceForUser } from "./utils";
import { resolveWritePath } from "~/server/lib/fs-access/write-paths";
import { atomicWrite } from "~/server/lib/fs-access/atomic-write";
import { restoreFromJournal, scheduleJournalGc } from "~/server/lib/fs-access/journal";
import { sha256File } from "~/server/lib/fs-access/diff";

/**
 * Undo an applied change: restores the journal copy over the target.
 *
 * Refuses when the on-disk digest no longer matches sha256After — the operator
 * (or someone) edited the file since, so restoring would destroy their work.
 * Never throws to the client; returns structured results the UI can show.
 */
export const undoFileChange = protectedProcedure
  .input(executeFileChangeInput.pick({ fileChangeId: true }))
  .mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;

    const change = await db.fileChange.findUnique({ where: { id: input.fileChangeId } });
    if (!change) {
      throw new TRPCError({ code: "NOT_FOUND", message: "File change not found" });
    }
    await assertInstanceOwnedByUser(userId, change.instanceId);

    if (change.status !== "applied") {
      return { ok: false as const, error: `Only applied changes can be undone (current: ${change.status}).` };
    }

    return withInstanceLock(change.instanceId, async () => {
      try {
        const instance = await getInstanceForUser(userId, change.instanceId);

        // Re-validate the target — never trust the stored path
        const reResolved = await resolveWritePath(change.path, instance.fsRootPath, { op: "undo" });
        if (!reResolved.ok) {
          return { ok: false as const, error: reResolved.error.message, code: reResolved.error.code };
        }
        const target = reResolved.path;

        // Refuse if the on-disk digest no longer matches sha256After —
        // restoring would destroy work done since the apply.
        let currentSha: string | null = null;
        try {
          currentSha = await sha256File(target);
        } catch {
          currentSha = null; // file gone (deleted after apply) — undo may still restore
        }
        if (currentSha !== null && change.sha256After && currentSha !== change.sha256After) {
          return {
            ok: false as const,
            code: "MODIFIED_SINCE_APPLY",
            error:
              "This file was modified after the change was applied. Restoring would overwrite those edits — review the file and undo manually if needed.",
          };
        }

        const result = await restoreFromJournal(change.id, target);
        await db.fileChange.update({
          where: { id: change.id },
          data: { status: "undone" },
        });
        void scheduleJournalGc();
        return { ok: true as const, status: "undone" as const, path: target, ...result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Journal copy missing → clean message, not an opaque failure
        if (/ENOENT/.test(message)) {
          return { ok: false as const, code: "BACKUP_EXPIRED", error: "The backup for this change has expired and was cleaned up." };
        }
        return { ok: false as const, error: message, code: "UNDO_FAILED" };
      }
    });
  });
