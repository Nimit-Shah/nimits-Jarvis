import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { encrypt } from "~/lib/crypto";
import { assertSafeMcpUrl } from "~/lib/mcp-url";
import { invalidateMcpClient } from "~/server/clients/mcp";
import { updateMcpServerSchema } from "./updateMcpServer.schema";

export const updateMcpServer = protectedProcedure
  .input(updateMcpServerSchema)
  .mutation(async ({ ctx, input }) => {
    const existing = await db.mcpServer.findUnique({ where: { id: input.serverId }, include: { instance: true } });
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
    if (existing.instance.userId !== ctx.session.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Not your instance" });

    const data: Record<string, unknown> = {};
    if (input.label !== undefined) data.label = input.label;
    if (input.url !== undefined) {
      try {
        assertSafeMcpUrl(input.url);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: (e as Error).message });
      }
      data.url = input.url;
      data.status = "unknown";
      data.needsSync = true;
      data.lastError = null;
    }
    if (input.headers !== undefined) {
      if (input.headers === null) data.headersEnc = null;
      else data.headersEnc = await encrypt(JSON.stringify(input.headers));
    }

    const updated = await db.mcpServer.update({ where: { id: input.serverId }, data });
    invalidateMcpClient(input.serverId);
    return updated;
  });
