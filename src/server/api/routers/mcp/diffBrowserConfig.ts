import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { diffBrowserConfigSchema } from "./diffBrowserConfig.schema";

const COMPARED = [
  "originMode",
  "browserMode",
  "headless",
  "noSandbox",
  "infraSeedEnabled",
  "cdpEndpoint",
  "executablePath",
  "userDataDir",
  "cdpConfirmed",
  "extensionConfirmed",
] as const;

/** Field-level diff between two browser rows — keeps test-first honest. */
export const diffBrowserConfig = protectedProcedure
  .input(diffBrowserConfigSchema)
  .query(async ({ ctx, input }) => {
    const [a, b] = await Promise.all([
      db.mcpServer.findUnique({ where: { id: input.serverIdA }, include: { instance: true } }),
      db.mcpServer.findUnique({ where: { id: input.serverIdB }, include: { instance: true } }),
    ]);
    if (!a || !b) throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
    if (a.instance.userId !== ctx.session.user.id || b.instance.userId !== ctx.session.user.id) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Not your instance" });
    }
    const rows = COMPARED.filter((f) => String(a[f] ?? "") !== String(b[f] ?? "")).map((f) => ({
      field: f,
      a: a[f] as unknown,
      b: b[f] as unknown,
    }));
    const [rulesA, rulesB] = await Promise.all([
      db.mcpOriginRule.findMany({ where: { mcpServerId: a.id, enabled: true }, select: { pattern: true, kind: true } }),
      db.mcpOriginRule.findMany({ where: { mcpServerId: b.id, enabled: true }, select: { pattern: true, kind: true } }),
    ]);
    const setA = new Set(rulesA.map((r) => `${r.kind}:${r.pattern}`));
    const setB = new Set(rulesB.map((r) => `${r.kind}:${r.pattern}`));
    const onlyA = [...setA].filter((x) => !setB.has(x));
    const onlyB = [...setB].filter((x) => !setA.has(x));
    return { aLabel: a.label, bLabel: b.label, fields: rows, onlyA, onlyB };
  });
