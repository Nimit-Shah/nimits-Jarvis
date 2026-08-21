import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { encrypt } from "~/lib/crypto";
import { assertSafeMcpUrl } from "~/lib/mcp-url";
import { getInstanceForUser } from "~/server/api/routers/nimits-jarvis/utils";
import { syncToolsForServer, invalidateMcpClient } from "~/server/clients/mcp";
import { addMcpServerSchema } from "./addMcpServer.schema";

export const addMcpServer = protectedProcedure
  .input(addMcpServerSchema)
  .mutation(async ({ ctx, input }) => {
    await getInstanceForUser(ctx.session.user.id, input.instanceId);

    try {
      assertSafeMcpUrl(input.url);
    } catch (e) {
      throw new TRPCError({ code: "BAD_REQUEST", message: (e as Error).message });
    }

    const server = await db.mcpServer.create({
      data: {
        instanceId: input.instanceId,
        name: input.name,
        label: input.label,
        url: input.url,
        headersEnc: input.headers ? await encrypt(JSON.stringify(input.headers)) : null,
      },
    });

    try {
      await syncToolsForServer(server.id);
    } catch (err) {
      await db.mcpServer.update({
        where: { id: server.id },
        data: { status: "failed", lastError: err instanceof Error ? err.message.slice(0, 500) : String(err) },
      });
    }

    // Ensure stale cache is cleared if URL was previously cached
    invalidateMcpClient(server.id);

    return { id: server.id };
  });
