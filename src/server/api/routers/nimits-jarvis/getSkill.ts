import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { protectedProcedure } from "~/server/api/trpc";
import { getSkillAudits } from "~/server/lib/skills/catalog";
import { materializeSkill } from "~/server/lib/skills/materialize";
import { getSkillInput } from "./getSkill.schema";
import { getOwnedSkill } from "./skill-utils";

/** Skill detail for the Settings viewer: metadata + instructions + findings. */
export const getSkill = protectedProcedure
  .input(getSkillInput)
  .query(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    const row = await getOwnedSkill(userId, input.slug);
    const materialized = await materializeSkill(row, {
      chatId: "",
      instanceId: row.instanceId ?? "",
    });
    // Raw file text for the editor (frontmatter included) — viewer uses
    // `instructions`, editor round-trips `raw`.
    let raw: string | null = null;
    try {
      raw = await readFile(join(row.dirPath, "SKILL.md"), "utf-8");
    } catch {
      raw = null;
    }
    // Third-party audits are informational enrichment (token-gated, may be
    // null) — enforcement stays with the static scan + untrusted default.
    // Attempted only when the source is a plain owner/repo GitHub URL.
    const repoMatch = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      row.sourceRepo ?? "",
    );
    const audits = repoMatch
      ? await getSkillAudits(`${repoMatch[1]}/${row.slug}`).catch(() => null)
      : null;
    return {
      skill: row,
      instructions:
        materialized.ok === true ? materialized.materialized.instructions : null,
      loadError: materialized.ok === false ? materialized.reason : null,
      references:
        materialized.ok === true ? materialized.materialized.references : [],
      raw,
      audits,
    };
  });
