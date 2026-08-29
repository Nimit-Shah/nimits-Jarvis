import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { getStreamingMessage as getStreamingMessageFromRedis } from "~/server/clients/redis";
import { getInstanceForUser } from "./utils";
import { z } from "zod";

export const getStreamingMessage = protectedProcedure
  .input(
    z
      .object({
        instanceId: z.string().optional(),
        chatId: z.string().optional(),
      })
      .optional(),
  )
  .query(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;

    let chatId = input?.chatId;

    if (chatId) {
      const chat = await db.chat.findUnique({
        where: { id: chatId },
        select: { id: true, instance: { select: { userId: true } } },
      });

      if (!chat || chat.instance.userId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Chat not found or does not belong to you",
        });
      }

      const messageId = await getStreamingMessageFromRedis(chatId);
      if (!messageId) return null;
      return { messageId };
    }

    const instance = await getInstanceForUser(userId, input?.instanceId);

    const firstChat = await db.chat.findFirst({
      where: { instanceId: instance.id },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    if (!firstChat) {
      return null;
    }

    chatId = firstChat.id;

    const messageId = await getStreamingMessageFromRedis(chatId);
    if (!messageId) return null;

    return { messageId };
  });
