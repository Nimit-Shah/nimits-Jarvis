import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { readFile, rename, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { executeFileChangeInput } from "./executeFileChange.schema";
import { assertInstanceOwnedByUser, withInstanceLock, db } from "./file-change-utils";
import { getInstanceForUser } from "./utils";
import { resolveWritePath } from "~/server/lib/fs-access/write-paths";
import { atomicWrite } from "~/server/lib/fs-access/atomic-write";
import { backupOriginal, scheduleJournalGc, journalDirFor } from "~/server/lib/fs-access/journal";
import { sha256File } from "~/server/lib/fs-access/diff";

/**
 * The ONLY code path that writes to disk. In order:
 *   1 assertInstanceOwnedByUser   2 status==="pending" (idempotent)
 *   3 resolveWritePath again      4 re-read + sha256 → stale
 *   5 journal copy                6 atomic write (mode preserved)
 *   7 verify sha256After          8 status="applied"  9 return summary
 *
 * The after-content comes from the journal dir written at pre-flight — the
 * client is never trusted to supply it. Never throws to the client: sets
 * status="failed" and returns a structured result so the model receives a
 * tool result it can reason about.
 */
export const executeFileChange = protectedProcedure
  .input(executeFileChangeInput)
  .mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;

    const change = await db.fileChange.findUnique({ where: { id: input.fileChangeId } });
    if (!change) {
      throw new TRPCError({ code: "NOT_FOUND", message: "File change not found" });
    }
    await assertInstanceOwnedByUser(userId, change.instanceId);

    // Reject path — normal outcome, not an error
    if (!input.approve) {
      if (change.status !== "pending") {
        return { ok: false as const, status: change.status, error: `Change already ${change.status}.` };
      }
      await db.fileChange.update({
        where: { id: change.id },
        data: { status: "rejected", rejectReason: input.rejectReason ?? null },
      });
      void scheduleJournalGc();
      return {
        ok: true as const,
        status: "rejected" as const,
        toolResult: {
          op: change.op,
          path: change.path,
          status: "rejected",
          ...(input.rejectReason ? { reason: input.rejectReason } : {}),
          message:
            "The operator declined this change." +
            (input.rejectReason ? ` Their note: ${input.rejectReason}` : " Propose a different approach if needed, but do not retry the identical write."),
        },
      };
    }

    if (change.status !== "pending") {
      return { ok: false as const, status: change.status, error: `Change already ${change.status}.` };
    }

    // Per-instance mutex — serialize all disk mutations
    return withInstanceLock(change.instanceId, async () => {
      const fresh = await db.fileChange.findUnique({ where: { id: change.id } });
      if (!fresh || fresh.status !== "pending") {
        return { ok: false as const, error: `Change already ${fresh?.status ?? "unknown"}.` };
      }

      try {
        const instance = await getInstanceForUser(userId, fresh.instanceId);

        // 3. Re-resolve from scratch — never trust the stored path
        const reResolved = await resolveWritePath(fresh.path, instance.fsRootPath, { op: fresh.op });
        if (!reResolved.ok) {
          await db.fileChange.update({ where: { id: fresh.id }, data: { status: "failed", error: reResolved.error.message } });
          return { ok: false as const, error: reResolved.error.message, code: reResolved.error.code };
        }
        const target = reResolved.path;

        // 4. TOCTOU guard: re-read + recompute digest; mismatch → stale
        let currentBuf: Buffer | null = null;
        try {
          currentBuf = await readFile(target);
        } catch {
          currentBuf = null;
        }
        const currentSha = currentBuf ? sha256Buffer(currentBuf) : null;
        if (currentSha !== (fresh.sha256Before ?? null)) {
          await db.fileChange.update({
            where: { id: fresh.id },
            data: { status: "stale", error: "File changed on disk since the diff was computed." },
          });
          return {
            ok: false as const,
            status: "stale" as const,
            toolResult: {
              status: "stale",
              path: target,
              message: "This file changed on disk after the diff was computed. Re-read it and propose the change again.",
            },
          };
        }

        const markApplied = async (extra: Record<string, unknown> = {}) => {
          await db.fileChange.update({
            where: { id: fresh.id },
            data: {
              status: "applied",
              approvedAt: new Date(),
              appliedAt: new Date(),
              messageId: await findAssistantMessageId(fresh.chatId),
              error: null,
              ...extra,
            },
          });
        };

        let summary: Record<string, unknown>;

        switch (fresh.op) {
          case "edit":
          case "write": {
            // After-content from the journal dir — never from the client
            const afterPath = join(journalDirFor(fresh.id), "after");
            const afterBuf = await readFile(afterPath);

            // 5. journal copy BEFORE the rename so undo works even if we die
            const backup = await backupOriginal(fresh.id, target);
            // 6. atomic write
            const { bytesWritten } = await atomicWrite(target, afterBuf);
            // 7. verify sha256After matches pre-flight
            const actualSha = await sha256File(target);
            const expectedSha = fresh.sha256After ?? "";
            if (actualSha !== expectedSha) {
              // Roll forward is impossible to trust — mark failed; the journal
              // copy still allows manual recovery.
              throw new Error(`Post-write digest mismatch: expected ${expectedSha.slice(0, 8)}, got ${actualSha.slice(0, 8)}`);
            }
            await markApplied({ backupPath: backup?.backupPath ?? null });
            summary = { op: fresh.op, path: target, bytesWritten, sha256After: actualSha, status: "applied" };
            break;
          }
          case "delete": {
            // To Trash, never unlink. Collision-safe name.
            const trashDir = join(homedir(), ".Trash");
            await mkdir(trashDir, { recursive: true });
            const trashPath = join(trashDir, `${basename(target)}.jarvis-${randomUUID().slice(0, 8)}`);
            const backup = await backupOriginal(fresh.id, target);
            await rename(target, trashPath);
            await markApplied({ backupPath: backup?.backupPath ?? null });
            summary = { op: "delete", path: target, trashedTo: trashPath, status: "applied" };
            break;
          }
          case "mkdir": {
            const parent = dirname(target);
            try {
              const ps = await stat(parent);
              if (!ps.isDirectory()) throw new Error("parent is not a directory");
            } catch {
              await db.fileChange.update({ where: { id: fresh.id }, data: { status: "failed", error: `Parent directory does not exist: ${parent}` } });
              return {
                ok: false as const,
                code: "PARENT_MISSING",
                toolResult: { status: "failed", path: target, message: `Parent directory does not exist: ${parent}. Propose an fs_mkdir for it first.` },
              };
            }
            await mkdir(target); // non-recursive; fails if exists (race-safe)
            await markApplied();
            summary = { op: "mkdir", path: target, status: "applied" };
            break;
          }
          case "move": {
            const toPath = fresh.toPath;
            if (!toPath) throw new Error("move change missing toPath");
            const reTo = await resolveWritePath(toPath, instance.fsRootPath, { op: "move" });
            if (!reTo.ok) {
              await db.fileChange.update({ where: { id: fresh.id }, data: { status: "failed", error: reTo.error.message } });
              return { ok: false as const, error: reTo.error.message, code: reTo.error.code };
            }
            let toExists = false;
            try {
              await stat(reTo.path);
              toExists = true;
            } catch {}
            if (toExists) {
              await db.fileChange.update({ where: { id: fresh.id }, data: { status: "failed", error: `Destination already exists: ${reTo.path}` } });
              return { ok: false as const, error: `Destination already exists: ${reTo.path}`, code: "ALREADY_EXISTS" };
            }
            const backup = await backupOriginal(fresh.id, target);
            await rename(target, reTo.path);
            await markApplied({ backupPath: backup?.backupPath ?? null });
            summary = { op: "move", path: target, toPath: reTo.path, status: "applied" };
            break;
          }
          default:
            throw new Error(`Unknown op: ${fresh.op}`);
        }

        void scheduleJournalGc();
        return { ok: true as const, status: "applied" as const, summary, toolResult: summary };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db.fileChange.update({ where: { id: fresh.id }, data: { status: "failed", error: message } }).catch(() => {});
        return { ok: false as const, error: message, code: "EXEC_FAILED" };
      }
    });
  });

/** Opportunistic backfill: latest assistant message in the chat, if persisted. */
async function findAssistantMessageId(chatId: string): Promise<string | null> {
  const msg = await db.message.findFirst({
    where: { chatId, role: "assistant" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return msg?.id ?? null;
}

function sha256Buffer(buf: Buffer): string {
  // Local import avoided at top level to keep diff.ts the single source
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(buf).digest("hex");
}
