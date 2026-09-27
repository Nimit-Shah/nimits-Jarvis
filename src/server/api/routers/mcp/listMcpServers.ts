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

    // Cross-row context (playwright rows, same user, same port): sandbox
    // agreement and sibling block hints. Dedication (one row per target)
    // means peers only ever appear for legacy violations — still displayed,
    // since the daemon refuses those groups loudly.
    const siblings = await db.mcpServer.findMany({
      where: { serverType: "playwright", instance: { userId: ctx.session.user.id } },
      select: {
        id: true,
        label: true,
        url: true,
        browserMode: true,
        cdpEndpoint: true,
        noSandbox: true,
        instanceId: true,
        instance: { select: { name: true } },
      },
    });
    const siblingRules = await db.mcpOriginRule.findMany({
      where: { mcpServerId: { in: siblings.map((s) => s.id) }, enabled: true, kind: "block" },
      select: { mcpServerId: true, pattern: true },
    });
    const blocksByServer = new Map<string, string[]>();
    for (const r of siblingRules) {
      const list = blocksByServer.get(r.mcpServerId) ?? [];
      list.push(r.pattern);
      blocksByServer.set(r.mcpServerId, list);
    }
    const portOf = (url: string): number | null => {
      try {
        const p = Number(new URL(url).port);
        return Number.isInteger(p) && p > 0 ? p : null;
      } catch {
        return null;
      }
    };
    return servers.map((s) => {
      const reachability = classifyReachability(s.url);
      const myPort = portOf(s.url);
      const peers = s.serverType === "playwright" && myPort !== null
        ? siblings.filter((p) => p.id !== s.id && portOf(p.url) === myPort)
        : [];
      const isManagedMode = (mode: string) => mode !== "cdp" && mode !== "extension";
      const managedNoSandbox: boolean[] = isManagedMode(s.browserMode) ? [s.noSandbox] : [];
      for (const p of peers) if (isManagedMode(p.browserMode)) managedNoSandbox.push(p.noSandbox);
      // Strictest wins on a shared child: sandbox stays on unless EVERY
      // managed participant opted out.
      const sandboxEffectiveOff = managedNoSandbox.length > 0 && managedNoSandbox.every(Boolean);
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
        needsTypeConfirmation: s.needsTypeConfirmation,
        hasHeaders: s.headersEnc !== null,
        reachability,
        reachableHere: isReachableHere(reachability),
        toolCount: countMap.get(s.id) ?? 0,
        enabledToolCount: enabledMap.get(s.id) ?? 0,
        serverType: s.serverType,
        originMode: s.originMode,
        policyVersion: s.policyVersion,
        appliedPolicyVersion: s.appliedPolicyVersion,
        policyApplying: s.policyVersion !== s.appliedPolicyVersion,
        browserMode: s.browserMode,
        browserChannel: s.browserChannel,
        executablePath: s.executablePath,
        userDataDir: s.userDataDir,
        cdpEndpoint: s.cdpEndpoint,
        cdpConfirmed: s.cdpConfirmed,
        extensionConfirmed: s.extensionConfirmed,
        cdpAllowed: s.cdpAllowed,
        headless: s.headless,
        noSandbox: s.noSandbox,
        infraSeedEnabled: s.infraSeedEnabled,
        infraSeedExcluded: s.infraSeedExcluded,
        sharedPort:
          peers.length > 0
            ? {
              port: myPort,
              participants: peers.map((p) => ({ label: p.label, instanceName: p.instance.name })),
            }
            : null,
        sandboxOverridden:
          isManagedMode(s.browserMode) && s.noSandbox && !sandboxEffectiveOff && managedNoSandbox.length > 1,
        siblingBlocks: peers.flatMap((p) =>
          (blocksByServer.get(p.id) ?? []).map((pattern) => ({ pattern, byLabel: p.label })),
        ),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    });
  });
