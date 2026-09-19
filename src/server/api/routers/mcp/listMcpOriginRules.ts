import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { listMcpOriginRulesSchema } from "./listMcpOriginRules.schema";

export const listMcpOriginRules = protectedProcedure
  .input(listMcpOriginRulesSchema)
  .query(async ({ ctx, input }) => {
    const server = await db.mcpServer.findUnique({ where: { id: input.serverId }, include: { instance: true } });
    if (!server) throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
    if (server.instance.userId !== ctx.session.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Not your instance" });

    return db.mcpOriginRule.findMany({ where: { mcpServerId: input.serverId }, orderBy: { createdAt: "asc" } });
  });
