import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { getInstanceForUser } from "./utils";
import { preflightFileChangeInput } from "./preflightFileChange.schema";
import { preFlightFileChange } from "./agent/tools/fs/preflight";
import { MAX_CHANGES_PER_MESSAGE } from "~/server/lib/fs-access/write-paths";

/**
 * Server-side pre-flight for a proposed file change. Computes the REAL effect
 * (never the model's intent), creates the FileChange row (status=pending),
 * and returns the card payload. Nothing touches disk.
 *
 * Enforces the per-message cap: at most 10 pending changes per chat — more
 * than that is a refactor the operator should drive, and a 40-card approval
 * queue will be click-through-approved without reading.
 */
export const preflightFileChange = protectedProcedure
  .input(preflightFileChangeInput)
  .mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    // Confused-deputy guard: caller must own the instance
    const instance = await getInstanceForUser(userId, input.instanceId);

    // Cap: pending changes in this chat
    const pendingCount = await db.fileChange.count({
      where: { chatId: input.chatId, status: "pending" },
    });
    if (pendingCount >= MAX_CHANGES_PER_MESSAGE) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `At most ${MAX_CHANGES_PER_MESSAGE} un-approved file changes per message. Approve or reject the pending ones first.`,
      });
    }

    // fsWriteAllowed ceiling — never trust the client
    if (!instance.fsWriteAllowed) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Write access is disabled for this project. Enable it in Settings → Files.",
      });
    }

    const result = await preFlightFileChange({
      instanceId: instance.id,
      chatId: input.chatId,
      toolCallId: input.toolCallId, // model's streamed call id — row key
      fsRoot: instance.fsRootPath,
      op: input.op,
      path: input.path,
      toPath: input.toPath,
      oldText: input.oldText,
      newText: input.newText,
      expectedOccurrences: input.expectedOccurrences,
      content: input.content,
      mode: input.mode,
    });

    if (!result.ok || !result.fileChange) {
      // Pre-flight failure: no card. Return as a structured error the model
      // can reason about (it becomes the tool result).
      return { ok: false as const, error: result.error };
    }

    return { ok: true as const, fileChange: result.fileChange };
  });
