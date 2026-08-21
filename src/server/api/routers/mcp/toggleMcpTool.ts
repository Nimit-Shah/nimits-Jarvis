import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { toggleMcpToolSchema } from "./toggleMcpTool.schema";

export const toggleMcpTool = protectedProcedure
  .input(toggleMcpToolSchema)
  .mutation(async ({ ctx, input }) => {
    const tool = await db.mcpTool.findUnique({ where: { id: input.toolId }, include: { server: { include: { instance: true } } } });
    if (!tool) throw new TRPCError({ code: "NOT_FOUND", message: "Tool not found" });
    if (tool.server.instance.userId !== ctx.session.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Not your instance" });

    const data: Record<string, unknown> = {};
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.cronSafe !== undefined) data.cronSafe = input.cronSafe;

    const updated = await db.mcpTool.update({ where: { id: input.toolId }, data });
    return updated;
  });
