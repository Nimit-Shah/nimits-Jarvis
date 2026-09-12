import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { listSkillsInput } from "./listSkills.schema";
import { getInstanceForUser } from "./utils";

/**
 * Skills for the composer submenu (§6.2) and Settings page (§6.3).
 * User-global rows plus this instance's rows. Ownership is implicit —
 * everything is scoped to the session user, so slugs cannot probe others.
 */
export const listSkills = protectedProcedure
  .input(listSkillsInput)
  .query(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    // Instance scoping is best-effort: without an instance only user-global
    // rows list (a fresh user with no instance yet still sees their skills).
    let instanceId: string | null = null;
    if (input.instanceId) {
      instanceId = (await getInstanceForUser(userId, input.instanceId)).id;
    } else {
      try {
        instanceId = (await getInstanceForUser(userId)).id;
      } catch {
        instanceId = null;
      }
    }

    const rows = await db.skill.findMany({
      where: {
        userId,
        ...(input.includeDisabled ? {} : { enabled: true }),
        OR: instanceId
          ? [{ instanceId: null }, { instanceId }]
          : [{ instanceId: null }],
      },
      select: {
        slug: true,
        displayName: true,
        description: true,
        trustTier: true,
        origin: true,
        sourceRepo: true,
        discoverySource: true,
        enabled: true,
        lastUsedAt: true,
        useCount: true,
        updatedAt: true,
      },
    });

    // lastUsedAt descending (never-used last), then slug — in JS so NULLS
    // sort after real timestamps regardless of database defaults.
    rows.sort((a, b) => {
      const at = a.lastUsedAt?.getTime() ?? -1;
      const bt = b.lastUsedAt?.getTime() ?? -1;
      if (at !== bt) return bt - at;
      return a.slug.localeCompare(b.slug);
    });

    return { items: rows, instanceId };
  });
