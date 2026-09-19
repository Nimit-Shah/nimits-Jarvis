import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { getInstanceForUser } from "~/server/api/routers/nimits-jarvis/utils";
import { infraSeedFlat } from "~/server/lib/browser/infra-origins";
import { listSeedCandidatesSchema } from "./listSeedCandidates.schema";

/**
 * Seed-growth evidence (display-only): discovered patterns seen on 3+
 * distinct servers of this instance that are not already in the seed.
 * The seed grows from evidence, never guessing.
 */
export const listSeedCandidates = protectedProcedure
  .input(listSeedCandidatesSchema)
  .query(async ({ ctx, input }) => {
    await getInstanceForUser(ctx.session.user.id, input.instanceId);
    const seed = new Set(infraSeedFlat());

    const rows = await db.mcpOriginRule.findMany({
      where: { enabled: true, origin: "discovered", server: { instanceId: input.instanceId } },
      select: { pattern: true, mcpServerId: true },
    });
    const byPattern = new Map<string, Set<string>>();
    for (const r of rows) {
      const set = byPattern.get(r.pattern) ?? new Set<string>();
      set.add(r.mcpServerId);
      byPattern.set(r.pattern, set);
    }
    return [...byPattern.entries()]
      .filter(([pattern, servers]) => servers.size >= 3 && !seed.has(pattern))
      .map(([pattern, servers]) => ({ pattern, serverCount: servers.size }))
      .sort((a, b) => b.serverCount - a.serverCount);
  });
