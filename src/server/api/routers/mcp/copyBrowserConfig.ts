import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { invalidateMcpClient } from "~/server/clients/mcp";
import { copyBrowserConfigSchema } from "./copyBrowserConfig.schema";

/**
 * Promote browser POLICY from one row to another. Copies policy only —
 * targets stay per-row: cdpEndpoint, executablePath, userDataDir,
 * cdpConfirmed are never touched (copying Personal's :9222 onto Default
 * would silently aim the test project at the real browser).
 */
const COPIED_SCALARS = ["originMode", "browserMode", "headless", "noSandbox", "infraSeedEnabled", "infraSeedExcluded"] as const;

export const copyBrowserConfig = protectedProcedure
  .input(copyBrowserConfigSchema)
  .mutation(async ({ ctx, input }) => {
    const [source, target] = await Promise.all([
      db.mcpServer.findUnique({ where: { id: input.sourceServerId }, include: { instance: true } }),
      db.mcpServer.findUnique({ where: { id: input.targetServerId }, include: { instance: true } }),
    ]);
    if (!source || !target) throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
    if (source.instance.userId !== ctx.session.user.id || target.instance.userId !== ctx.session.user.id) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Not your instance" });
    }
    if (source.serverType !== "playwright" || target.serverType !== "playwright") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Both rows must be browser (Playwright) servers." });
    }

    const data: Record<string, unknown> = { policyVersion: { increment: 1 } };
    for (const key of COPIED_SCALARS) data[key] = source[key];

    const rules = await db.mcpOriginRule.findMany({ where: { mcpServerId: source.id } });
    await db.$transaction([
      db.mcpServer.update({ where: { id: target.id }, data }),
      db.mcpOriginRule.deleteMany({ where: { mcpServerId: target.id } }),
      ...rules.map((r) =>
        db.mcpOriginRule.create({
          data: {
            mcpServerId: target.id,
            pattern: r.pattern,
            kind: r.kind,
            origin: "manual",
            enabled: r.enabled,
            notes: r.notes,
          },
        }),
      ),
    ]);
    invalidateMcpClient(target.id);
    return { ok: true as const, copiedRules: rules.length, skippedTargets: ["cdpEndpoint", "executablePath", "userDataDir", "cdpConfirmed"] };
  });
