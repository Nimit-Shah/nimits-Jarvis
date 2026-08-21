import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { discoverMcpTools, invalidateMcpClient } from "~/server/clients/mcp";
import { testMcpServerSchema } from "./testMcpServer.schema";

export const testMcpServer = protectedProcedure
  .input(testMcpServerSchema)
  .mutation(async ({ ctx, input }) => {
    const server = await db.mcpServer.findUnique({ where: { id: input.serverId }, include: { instance: true } });
    if (!server) throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
    if (server.instance.userId !== ctx.session.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Not your instance" });

    const start = Date.now();
    invalidateMcpClient(server.id);
    try {
      const tools = await discoverMcpTools(server as never);
      const latencyMs = Date.now() - start;
      await db.mcpServer.update({
        where: { id: server.id },
        data: { status: "ok", lastError: null, lastSyncedAt: new Date() },
      });
      return { ok: true, toolCount: tools.length, latencyMs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.mcpServer.update({
        where: { id: server.id },
        data: { status: "failed", lastError: msg.slice(0, 500) },
      });
      return { ok: false, error: msg.slice(0, 500), latencyMs: Date.now() - start };
    }
  });
