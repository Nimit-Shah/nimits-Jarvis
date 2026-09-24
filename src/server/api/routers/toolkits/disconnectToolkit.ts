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
    // isConnected: true is essential — without it this paginates the ENTIRE
    // ~1500-toolkit catalog (31 pages) against a 10-page cap, so connected
    // toolkits deep in the catalog (e.g. supadata) were never found and the
    // disconnect threw FORBIDDEN.
    let matchedSlug: string | undefined;
    let cursor: string | undefined;

    for (let i = 0; i < 10 && !matchedSlug; i++) {
      const page = await session.toolkits({
        limit: 50,
        isConnected: true,
        ...(cursor ? { cursor } : {}),
      });
      const match = page.items.find(
        (toolkit) =>
          toolkit.connection?.connectedAccount?.id === input.connectionId,
      );
      if (match) {
        matchedSlug = match.slug;
        break;
      }
      cursor = page.cursor ?? undefined;
      if (!cursor || page.items.length === 0) break;
    }

    if (!matchedSlug) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Connection does not belong to this project instance",
      });
    }

    // Delete ALL connected accounts for this toolkit slug — a toolkit can
    // accumulate duplicate ACTIVE accounts (re-connects), and removing only
    // the one the session surfaces would leave the card stuck "connected".
    // List is scoped to this project's API key, same as the ownership check.
    const accounts = await composio.connectedAccounts.list({
      toolkitSlugs: [matchedSlug],
      limit: 100,
    });
    const toDelete = accounts.items.filter(
      (account) => account.id === input.connectionId || account.status === "ACTIVE",
    );
    for (const account of toDelete) {
      await composio.connectedAccounts.delete(account.id);
    }
    if (toDelete.length === 0) {
      // Ownership passed but the account vanished between check and delete —
      // treat as success so the UI can refresh to the true state.
      console.warn(
        `[toolkits] disconnect: owned connection ${input.connectionId} not in account list for ${matchedSlug}`,
      );
    }

    // Invalidate the agent's cached session+tools so the next turn rebuilds
    // without the now-disconnected toolkit.
    invalidateSession(instance.id);

    return { success: true };
  });
