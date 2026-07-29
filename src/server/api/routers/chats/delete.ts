import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
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

    await db.$transaction(async (tx) => {
      await tx.message.deleteMany({ where: { chatId: chat.id } });
      await tx.cronJob.deleteMany({ where: { chatId: chat.id } });
      await tx.chat.delete({ where: { id: chat.id } });
    });

    return { success: true };
  });