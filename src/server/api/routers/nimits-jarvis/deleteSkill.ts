import { rm } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { getSkillsRoot } from "~/server/lib/skills/constants";
import { deleteSkillInput } from "./deleteSkill.schema";
import { getOwnedSkill } from "./skill-utils";

/**
 * Delete a skill: DB row plus its directory. The directory is removed so a
 * later reconciliation does not resurrect the row — removal is refused
 * unless the stored dirPath sits under the skills root.
 */
export const deleteSkill = protectedProcedure
  .input(deleteSkillInput)
  .mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    const row = await getOwnedSkill(userId, input.slug);

    try {
      const root = getSkillsRoot();
      const real = await realpath(row.dirPath);
      if (real === root || real.startsWith(root + sep)) {
        await rm(real, { recursive: true, force: true });
      } else {
        console.warn("[skills/delete] dirPath outside skills root, row only", {
          slug: row.slug,
          dirPath: row.dirPath,
        });
      }
    } catch {
      // Missing dir — row deletion below still proceeds.
    }

    await db.skillState.deleteMany({ where: { skillId: row.id } });
    await db.skill.delete({ where: { id: row.id } });
    return { deleted: row.slug };
  });
