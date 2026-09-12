import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { updateSkillInput } from "./updateSkill.schema";
import { getOwnedSkill } from "./skill-utils";

/**
 * Metadata update + enable/disable + trust-tier promotion. Tier changes are
 * explicit and logged — promotion names what the tier grants (client shows
 * the confirmation; the server records it).
 */
export const updateSkill = protectedProcedure
  .input(updateSkillInput)
  .mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    const row = await getOwnedSkill(userId, input.slug);

    if (input.trustTier && input.trustTier !== row.trustTier) {
      console.log(
        "[skills/trust]",
        JSON.stringify({
          userId,
          slug: row.slug,
          from: row.trustTier,
          to: input.trustTier,
        }),
      );
    }

    return db.skill.update({
      where: { id: row.id },
      data: {
        ...(input.displayName !== undefined && { displayName: input.displayName }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.trustTier !== undefined && { trustTier: input.trustTier }),
      },
    });
  });
