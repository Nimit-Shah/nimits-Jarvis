import { z } from "zod";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";

/**
 * Fetch a FileChange row by the model's streamed toolCallId (for the approval
 * card) or by row id (for undo state refresh). Ownership-checked.
 */
export const getFileChange = protectedProcedure
  .input(z.object({ toolCallId: z.string().optional(), id: z.string().optional() }))
  .query(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    if (!input.toolCallId && !input.id) return null;

    const row = input.toolCallId
      ? await db.fileChange.findUnique({ where: { toolCallId: input.toolCallId } })
      : await db.fileChange.findUnique({ where: { id: input.id! } });

    if (!row) return null;

    // Ownership: the change's instance must belong to the caller
    const owned = await db.composioClawInstance.findFirst({
      where: { id: row.instanceId, userId },
      select: { id: true },
    });
    if (!owned) return null;

    return {
      id: row.id,
      toolCallId: row.toolCallId,
      op: row.op,
      path: row.path,
      toPath: row.toPath,
      sha256Before: row.sha256Before,
      sha256After: row.sha256After,
      bytesBefore: row.bytesBefore,
      bytesAfter: row.bytesAfter,
      diff: row.diff,
      status: row.status,
      rejectReason: row.rejectReason,
      error: row.error,
      backupPath: row.backupPath,
      createdAt: row.createdAt.toISOString(),
      appliedAt: row.appliedAt?.toISOString() ?? null,
    };
  });
