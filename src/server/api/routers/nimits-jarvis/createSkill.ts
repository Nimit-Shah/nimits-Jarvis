import { mkdir, writeFile } from "node:fs/promises";
import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { getSkillDir, getSkillsRoot } from "~/server/lib/skills/constants";
import { parseSkillText, sha256Hex } from "~/server/lib/skills/parse";
import { scanFindingsJson, scanSkillBody } from "~/server/lib/skills/scan";
import { createSkillInput } from "./createSkill.schema";

/**
 * Scaffold a new authored skill: directory + SKILL.md template + DB row.
 * Operator-authored means operator-reviewed, so it lands trusted. The
 * template bakes in the trigger-condition guidance — the highest-leverage
 * authoring rule.
 */
export function scaffoldSkillBody(slug: string, description: string): string {
  return `---\nname: ${slug}\ndescription: ${description}\ntools_required:\n - fs_read\nstate_scope: none\nversion: 0.1.0\n---\n\n# ${slug}\n\n<!-- Write the description above as a trigger condition ("Use when ..."),\nnot a summary. The index shows only that line before the model decides.\nWeak: "Screenplay writing helper."\nStrong: "Use when the user wants a screenplay, script, or shot list." -->\n\n<!-- tools_required is a CAP: while this skill is pinned, only declared tools\nplus memory/scheduling/read_tool_result are available. Declare everything the\nprocedure needs; undeclared tools are reported missing, never substituted. -->\n\n<!-- state_scope: none | session (per chat) | persistent (per project).\nStateful skills read state on load and write it with a fenced block:\n\`\`\`skill-state ${slug}\n{"key": "value"}\n\`\`\` -->\n\n## When this applies\n\n...\n\n## Procedure\n\n1. ...\n\n## Output format\n\n...\n`;
}

export const createSkill = protectedProcedure
  .input(createSkillInput)
  .mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    const existing = await db.skill.findUnique({
      where: { userId_slug: { userId, slug: input.slug } },
    });
    if (existing) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `A skill named "${input.slug}" already exists.`,
      });
    }

    const root = getSkillsRoot();
    const dir = getSkillDir(root, input.slug);
    try {
      await mkdir(dir, { recursive: false });
    } catch (err) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `Could not create skill directory: ${(err as NodeJS.ErrnoException).code ?? String(err)}`,
      });
    }
    await mkdir(`${dir}/references`, { recursive: true });

    const body = scaffoldSkillBody(input.slug, input.description);
    await writeFile(`${dir}/SKILL.md`, body, "utf-8");

    const parsed = parseSkillText(body);
    if (!parsed.ok) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: parsed.reason });
    }
    return db.skill.create({
      data: {
        userId,
        slug: parsed.skill.slug,
        displayName: input.displayName ?? parsed.skill.slug,
        description: parsed.skill.description,
        origin: "authored",
        dirPath: dir,
        contentHash: sha256Hex(body),
        version: parsed.skill.version,
        trustTier: "trusted",
        toolsRequired: parsed.skill.toolsRequired,
        stateScope: parsed.skill.stateScope,
        scanFindings: scanFindingsJson(scanSkillBody(body, parsed.skill)),
      },
    });
  });
