import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { normalizeOriginPattern } from "~/server/lib/browser/origins";
import { addMcpOriginRuleSchema } from "./addMcpOriginRule.schema";

export const addMcpOriginRule = protectedProcedure
  .input(addMcpOriginRuleSchema)
  .mutation(async ({ ctx, input }) => {
    const server = await db.mcpServer.findUnique({ where: { id: input.serverId }, include: { instance: true } });
    if (!server) throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
    if (server.instance.userId !== ctx.session.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Not your instance" });

    const pattern = normalizeOriginPattern(input.pattern);
    const rule = await db.mcpOriginRule.upsert({
      where: { mcpServerId_pattern_kind: { mcpServerId: input.serverId, pattern, kind: input.kind } },
      create: { mcpServerId: input.serverId, pattern, kind: input.kind, origin: "manual", notes: input.notes },
      update: { enabled: true, notes: input.notes },
    });
    await db.mcpServer.update({ where: { id: input.serverId }, data: { policyVersion: { increment: 1 } } });
    return rule;
  });
