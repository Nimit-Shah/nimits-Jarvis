import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { syncToolsForServer } from "~/server/clients/mcp";
import { syncMcpToolsSchema } from "./syncMcpTools.schema";

export const syncMcpTools = protectedProcedure
  .input(syncMcpToolsSchema)
  .mutation(async ({ ctx, input }) => {
    const server = await db.mcpServer.findUnique({ where: { id: input.serverId }, include: { instance: true } });
    if (!server) throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
    if (server.instance.userId !== ctx.session.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Not your instance" });

    try {
      await syncToolsForServer(input.serverId);
      // Propose-only browser detection: a generic row exposing the two named
      // tools is probably a browser server. Never auto-flips serverType —
      // an automatic flip would spawn an unasked browser child.
      if (server.serverType === "generic" && !server.needsTypeConfirmation) {
        const names = new Set(
          (
            await db.mcpTool.findMany({ where: { mcpServerId: input.serverId }, select: { originalName: true } })
          ).map((t) => t.originalName),
        );
        if (names.has("browser_navigate") && names.has("browser_snapshot")) {
          await db.mcpServer.update({ where: { id: input.serverId }, data: { needsTypeConfirmation: true } });
        }
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.mcpServer.update({ where: { id: input.serverId }, data: { status: "failed", lastError: msg.slice(0, 500) } });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: msg });
    }
  });
