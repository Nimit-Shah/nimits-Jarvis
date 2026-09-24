import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { getHistoryInput } from "./getHistory.schema";
import { getInstanceForUser } from "./utils";

export const getHistory = protectedProcedure
  .input(getHistoryInput)
  .query(async ({ input, ctx }) => {
    const userId = ctx.session.user.id;

    let chatId = input.chatId;

    if (chatId) {
      const chat = await db.chat.findUnique({
        where: { id: chatId },
        select: { id: true, instanceId: true, instance: { select: { userId: true } } },
      });

      if (!chat || chat.instance.userId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Chat not found or does not belong to you",
        });
      }

      const messages = await db.message.findMany({
        where: {
          chatId,
          instanceId: chat.instanceId,
          messageType: "regular",
          ...(input.cursor ? { createdAt: { lt: new Date(input.cursor) } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        select: {
          id: true,
          role: true,
          content: true,
          source: true,
          runStatus: true,
          inputTokens: true,
          outputTokens: true,
          createdAt: true,
          attachments: {
            select: { id: true, mimeType: true, width: true, height: true },
            orderBy: { createdAt: "asc" },
          },
        },
      });

      let nextCursor: string | undefined;
      if (messages.length > input.limit) {
        const lastItem = messages.pop()!;
        nextCursor = lastItem.createdAt.toISOString();
      }

      return {
        messages: messages.reverse(),
        nextCursor,
      };
    }

    const instance = await getInstanceForUser(userId, input.instanceId);

    const firstChat = await db.chat.findFirst({
      where: { instanceId: instance.id },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    if (!firstChat) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "No chats found for this instance",
      });
    }

    chatId = firstChat.id;

    const messages = await db.message.findMany({
      where: {
        chatId,
        instanceId: instance.id,
        messageType: "regular",
        ...(input.cursor ? { createdAt: { lt: new Date(input.cursor) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: input.limit + 1,
        select: {
          id: true,
          role: true,
          content: true,
          source: true,
          runStatus: true,
          inputTokens: true,
          outputTokens: true,
          createdAt: true,
          attachments: {
            select: { id: true, mimeType: true, width: true, height: true },
            orderBy: { createdAt: "asc" },
          },
        },
      });

      let nextCursor: string | undefined;
    if (messages.length > input.limit) {
      const lastItem = messages.pop()!;
      nextCursor = lastItem.createdAt.toISOString();
    }

    return {
      messages: messages.reverse(),
      nextCursor,
    };
  });
