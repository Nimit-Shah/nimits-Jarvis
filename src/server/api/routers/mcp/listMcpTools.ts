import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { getInstanceForUser } from "~/server/api/routers/nimits-jarvis/utils";
import { listMcpToolsSchema } from "./listMcpTools.schema";

export const listMcpTools = protectedProcedure
  .input(listMcpToolsSchema)
  .query(async ({ ctx, input }) => {
    const server = await db.mcpServer.findUnique({ where: { id: input.serverId }, include: { instance: true } });
    if (!server || server.instance.userId !== ctx.session.user.id) return [];
    // Ownership already checked via instance; also ensure server exists
    await getInstanceForUser(ctx.session.user.id, server.instanceId);
    const tools = await db.mcpTool.findMany({
      where: { mcpServerId: input.serverId },
      orderBy: { originalName: "asc" },
    });
    return tools;
  });
