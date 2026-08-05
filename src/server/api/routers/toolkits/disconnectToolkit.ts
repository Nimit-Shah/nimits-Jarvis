import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { createComposioClientForInstance, invalidateSession } from "~/server/clients/composio";
import { decrypt } from "~/lib/crypto";
import { getInstanceForUser } from "~/server/api/routers/nimits-jarvis/utils";

export const disconnectToolkit = protectedProcedure
  .input(
    z.object({
      instanceId: z.string().optional(),
      connectionId: z.string(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;

    // Ownership-checked instance resolution
    const instance = await getInstanceForUser(userId, input.instanceId);

    // Decrypt per-project API key if present
    const decryptedApiKey = instance.composioApiKey
      ? await decrypt(instance.composioApiKey)
      : null;

    const composio = createComposioClientForInstance(decryptedApiKey);
    const session = await composio.create(instance.id, {});

    // Verify the connectionId actually belongs to this instance before deleting.
    // This prevents a user from passing an arbitrary connectionId belonging to
    // another user or project. Paginate through results in case the user has
    // more than 50 connected toolkits (Composio API caps at 50 per page).
    let isOwned = false;
    let cursor: string | undefined;

    for (let i = 0; i < 10 && !isOwned; i++) {
      const page = await session.toolkits({
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      isOwned = page.items.some(
        (toolkit) =>
          toolkit.connection?.connectedAccount?.id === input.connectionId,
      );
      cursor = page.cursor ?? undefined;
      if (!cursor || page.items.length === 0) break;
    }

    if (!isOwned) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Connection does not belong to this project instance",
      });
    }

    await composio.connectedAccounts.delete(input.connectionId);

    // Invalidate the agent's cached session+tools so the next turn rebuilds
    // without the now-disconnected toolkit.
    invalidateSession(instance.id);

    return { success: true };
  });
