import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import {
  clearVaultSnapshot,
  getStreamingMessage,
  releaseChatRun,
} from "~/server/clients/redis";
import { cancelRun } from "~/server/lib/run-registry";
import { deleteChatInput } from "./delete.schema";

export const deleteChat = protectedProcedure
  .input(deleteChatInput)
  .mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;

    const chat = await db.chat.findFirst({
      where: {
        id: input.chatId,
        instance: { userId },
      },
      select: { id: true, instanceId: true },
    });

    if (!chat) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Chat not found or does not belong to you",
      });
    }

    // Stop any live run first: otherwise the orphaned agent keeps calling
    // tools after its conversation is gone, and the Redis pointer + vault
    // snapshot outlive the chat as stale resume state.
    const activeStream = await getStreamingMessage(chat.id);
    if (activeStream) {
      cancelRun(activeStream);
      await releaseChatRun(chat.id, activeStream);
      await clearVaultSnapshot(activeStream);
    }

    await db.$transaction(async (tx) => {
      await tx.messageAttachment.deleteMany({ where: { chatId: chat.id } });
      await tx.message.deleteMany({ where: { chatId: chat.id } });
      await tx.cronJob.deleteMany({ where: { chatId: chat.id } });
      await tx.chat.delete({ where: { id: chat.id } });
    });

    // Attachment bytes live on disk (rows cascade, files don't) — remove the
    // chat's directory. Fire-and-forget; the GC sweep covers failures.
    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { getAttachmentsRoot } = await import("~/server/lib/attachments/constants");
    void rm(join(getAttachmentsRoot(), chat.instanceId, chat.id), { recursive: true, force: true });

    return { success: true };
  });
