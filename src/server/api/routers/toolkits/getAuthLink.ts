import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { createComposioClientForInstance, invalidateSession } from "~/server/clients/composio";
import { decrypt } from "~/lib/crypto";
import { getInstanceForUser } from "~/server/api/routers/nimits-jarvis/utils";
import { env } from "~/env";
import { getAuthLinkInput } from "./getAuthLink.schema";

export const getAuthLink = protectedProcedure
  .input(getAuthLinkInput)
  .mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;

    // Resolve project instance with ownership check
    const instance = await getInstanceForUser(userId, input.instanceId);

    // Decrypt per-project API key if present; fall back to global env key
    const decryptedApiKey = instance.composioApiKey
      ? await decrypt(instance.composioApiKey)
      : null;

const composio = createComposioClientForInstance(decryptedApiKey);
    // Scope connections precisely to the active project instance ID
    const session = await composio.create(instance.id, {});

    try {
      const connectionRequest = await session.authorize(input.toolkit, {
        callbackUrl: `${env.NEXT_PUBLIC_APP_URL}/dashboard/toolkits`,
      });
      const redirectUrl = connectionRequest.redirectUrl;

      // A connection is being initiated/added — invalidate the agent's cached
      // session+tools so the next turn reflects the new connection once OAuth
      // completes (WAIT_FOR_CONNECTIONS handles the post-completion handshake).
      invalidateSession(instance.id);

      if (!redirectUrl) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to generate OAuth URL for this toolkit",
        });
      }

      return { redirectUrl };
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      // No-auth toolkits (e.g. gemini) can't be authorized — Composio returns
      // 400 code 4326 (ToolRouterV2_ToolkitsIsNoAuth). There is no OAuth flow;
      // their tools are already usable, so report success with no redirect.
      if (
        (error as { error?: { code?: unknown } } | null)?.error?.code === 4326
      ) {
        return { redirectUrl: null };
      }
      console.error(
        `[toolkits.getAuthLink] authorize failed for "${input.toolkit}":`,
        error instanceof Error ? error.message : error,
      );
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: error instanceof Error ? error.message : `Failed to authorize ${input.toolkit}`,
      });
    }
  });
