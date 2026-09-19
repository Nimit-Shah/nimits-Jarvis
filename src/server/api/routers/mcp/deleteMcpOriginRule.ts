import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { deleteMcpOriginRuleSchema } from "./deleteMcpOriginRule.schema";

export const deleteMcpOriginRule = protectedProcedure
  .input(deleteMcpOriginRuleSchema)
  .mutation(async ({ ctx, input }) => {
    const rule = await db.mcpOriginRule.findUnique({ where: { id: input.ruleId }, include: { server: { include: { instance: true } } } });
    if (!rule) throw new TRPCError({ code: "NOT_FOUND", message: "Rule not found" });
    if (rule.server.instance.userId !== ctx.session.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Not your instance" });

    await db.mcpOriginRule.delete({ where: { id: input.ruleId } });
    await db.mcpServer.update({ where: { id: rule.mcpServerId }, data: { policyVersion: { increment: 1 } } });
    return { ok: true as const };
  });
