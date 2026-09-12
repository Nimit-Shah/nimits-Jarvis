import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { parseSkillText, sha256Hex } from "~/server/lib/skills/parse";
import { scanFindingsJson, scanSkillBody } from "~/server/lib/skills/scan";
import { updateSkillBodyInput } from "./updateSkillBody.schema";
import { getOwnedSkill } from "./skill-utils";

/**
 * In-app body editor (authored skills only). Imported skills are edited at
 * their source, not here — forking an import starts with Create instead.
 * The new text is parsed before anything is written; failures reject loudly
 * and the file is untouched.
 */
export const updateSkillBody = protectedProcedure
  .input(updateSkillBodyInput)
  .mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    const row = await getOwnedSkill(userId, input.slug);
    if (row.origin !== "authored") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only authored skills can be edited here. Imported skills are edited at their source.",
      });
    }

    const parsed = parseSkillText(input.body);
    if (!parsed.ok) {
      throw new TRPCError({ code: "BAD_REQUEST", message: parsed.reason });
    }
    if (parsed.skill.slug !== row.slug) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Frontmatter name "${parsed.skill.slug}" does not match slug "${row.slug}" — the slug is stable and cannot be renamed by editing.`,
      });
    }

    await writeFile(join(row.dirPath, "SKILL.md"), input.body, "utf-8");
    return db.skill.update({
      where: { id: row.id },
      data: {
        displayName: parsed.skill.displayName,
        description: parsed.skill.description,
        contentHash: sha256Hex(input.body),
        version: parsed.skill.version,
        toolsRequired: parsed.skill.toolsRequired,
        stateScope: parsed.skill.stateScope,
        scanFindings: scanFindingsJson(scanSkillBody(input.body, parsed.skill)),
      },
    });
  });
