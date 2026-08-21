import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { invalidateMcpClient } from "~/server/clients/mcp";
import { deleteMcpServerSchema } from "./deleteMcpServer.schema";

export const deleteMcpServer = protectedProcedure
  .input(deleteMcpServerSchema)
  .mutation(async ({ ctx, input }) => {
    const existing = await db.mcpServer.findUnique({ where: { id: input.serverId }, include: { instance: true } });
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
    if (existing.instance.userId !== ctx.session.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Not your instance" });

    await db.mcpServer.delete({ where: { id: input.serverId } });
    invalidateMcpClient(input.serverId);
    return { ok: true };
  });
