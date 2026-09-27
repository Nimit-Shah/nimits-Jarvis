import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { listBrowserRowsSchema } from "./listBrowserRows.schema";

/** All playwright rows across the caller's instances — source picker for copy/diff. */
export const listBrowserRows = protectedProcedure.input(listBrowserRowsSchema).query(async ({ ctx }) => {
  const rows = await db.mcpServer.findMany({
    where: { serverType: "playwright", instance: { userId: ctx.session.user.id } },
    select: {
      id: true,
      name: true,
      label: true,
      instanceId: true,
      browserMode: true,
      originMode: true,
      instance: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ ...r, instanceName: r.instance.name }));
});
