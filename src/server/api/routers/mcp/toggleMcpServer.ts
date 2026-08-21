import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { toggleMcpServerSchema } from "./toggleMcpServer.schema";

export const toggleMcpServer = protectedProcedure
  .input(toggleMcpServerSchema)
  .mutation(async ({ ctx, input }) => {
    const existing = await db.mcpServer.findUnique({ where: { id: input.serverId }, include: { instance: true } });
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
    if (existing.instance.userId !== ctx.session.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Not your instance" });

    const updated = await db.mcpServer.update({ where: { id: input.serverId }, data: { enabled: input.enabled } });
    return updated;
  });
