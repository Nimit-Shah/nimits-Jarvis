import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { toggleMcpOriginRuleSchema } from "./toggleMcpOriginRule.schema";

export const toggleMcpOriginRule = protectedProcedure
  .input(toggleMcpOriginRuleSchema)
  .mutation(async ({ ctx, input }) => {
    const rule = await db.mcpOriginRule.findUnique({ where: { id: input.ruleId }, include: { server: { include: { instance: true } } } });
    if (!rule) throw new TRPCError({ code: "NOT_FOUND", message: "Rule not found" });
    if (rule.server.instance.userId !== ctx.session.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Not your instance" });

    const updated = await db.mcpOriginRule.update({ where: { id: input.ruleId }, data: { enabled: input.enabled } });
    await db.mcpServer.update({ where: { id: rule.mcpServerId }, data: { policyVersion: { increment: 1 } } });
    return updated;
  });
