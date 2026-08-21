import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { getInstanceForUser } from "~/server/api/routers/nimits-jarvis/utils";
import { classifyReachability, isReachableHere } from "~/lib/mcp-url";
import { listMcpServersSchema } from "./listMcpServers.schema";

export const listMcpServers = protectedProcedure
  .input(listMcpServersSchema)
  .query(async ({ ctx, input }) => {
    await getInstanceForUser(ctx.session.user.id, input.instanceId);

    const servers = await db.mcpServer.findMany({
      where: { instanceId: input.instanceId },
      include: { _count: { select: { tools: true } } },
      orderBy: { createdAt: "asc" },
    });

    const toolsCounts = await db.mcpTool.groupBy({
      by: ["mcpServerId"],
      where: { mcpServerId: { in: servers.map((s) => s.id) } },
      _count: { id: true },
    });
    const enabledCounts = await db.mcpTool.groupBy({
      by: ["mcpServerId"],
      where: { mcpServerId: { in: servers.map((s) => s.id) }, enabled: true },
      _count: { id: true },
    });

    const countMap = new Map(toolsCounts.map((c) => [c.mcpServerId, c._count.id]));
    const enabledMap = new Map(enabledCounts.map((c) => [c.mcpServerId, c._count.id]));

    return servers.map((s) => {
      const reachability = classifyReachability(s.url);
      return {
        id: s.id,
        name: s.name,
        label: s.label,
        url: s.url,
        enabled: s.enabled,
        status: s.status,
        lastError: s.lastError,
        lastSyncedAt: s.lastSyncedAt,
        needsSync: s.needsSync,
        hasHeaders: s.headersEnc !== null,
        reachability,
        reachableHere: isReachableHere(reachability),
        toolCount: countMap.get(s.id) ?? 0,
        enabledToolCount: enabledMap.get(s.id) ?? 0,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    });
  });
