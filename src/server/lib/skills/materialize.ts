import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { db } from "~/server/clients/db";
import { parseSkillFile } from "./parse";
import { stateProtocolText } from "./state";

export interface MaterializedSkill {
  instructions: string;
  /** Fresh from frontmatter — correct even before the next reconciliation. */
  toolsRequired: string[];
  references: string[];
  state: unknown;
}

export type MaterializeResult =
  | { ok: true; materialized: MaterializedSkill }
  | { ok: false; reason: string };

/**
 * Shared loader for both entry points: load_skill (model-driven, Phase 3)
 * and pinned pre-load (operator-driven, Phase 4). Reads SKILL.md fresh from
 * the stored dirPath, lists references/ filenames (never contents), and
 * fetches SkillState for session/persistent scopes via sentinel keys.
 */
export async function materializeSkill(
  skill: { id: string; dirPath: string; stateScope: string },
  scope: { chatId: string; instanceId: string },
): Promise<MaterializeResult> {
  const parsed = await parseSkillFile(join(skill.dirPath, "SKILL.md"));
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  let references: string[] = [];
  try {
    references = (await readdir(join(skill.dirPath, "references"))).sort();
  } catch {
    references = [];
  }

  let state: unknown = null;
  if (skill.stateScope !== "none") {
    const row = await db.skillState.findUnique({
      where: {
        skillId_chatId_instanceId: {
          skillId: skill.id,
          chatId: skill.stateScope === "session" ? scope.chatId : "",
          instanceId:
            skill.stateScope === "persistent" ? scope.instanceId : "",
        },
      },
    });
    state = row?.data ?? null;
  }

  return {
    ok: true,
    materialized: {
      instructions: parsed.skill.instructions,
      toolsRequired: parsed.skill.toolsRequired,
      references,
      state,
    },
  };
}

/**
 * Pinned-skill tail block (§3.3). Appended post-shield so instructions reach
 * the model verbatim — the same exemption load_skill gets structurally.
 * Mirrors the load_skill payload so both entries behave identically.
 */
export function formatPinnedSkillBlock(input: {
  slug: string;
  displayName: string;
  instructions: string;
  stateScope: string;
  toolsMissing: string[];
  references: string[];
  state: unknown;
}): string {
  const lines = [
    "---",
    `Pinned skill: ${input.displayName} (${input.slug}) — pinned by the operator for this message. Follow its instructions as if load_skill("${input.slug}") had been called.`,
    "",
    input.instructions,
  ];
  if (input.toolsMissing.length > 0) {
    lines.push(
      "",
      `Declared-but-unavailable tools (report this, do not substitute): ${input.toolsMissing.join(", ")}`,
    );
  }
  if (input.references.length > 0) {
    lines.push(
      "",
      `Reference files (read with fs_read when needed): ${input.references.join(", ")}`,
    );
  }
  if (input.state !== null && input.state !== undefined) {
    lines.push("", `Skill state: ${JSON.stringify(input.state)}`);
  }
  if (input.stateScope === "session" || input.stateScope === "persistent") {
    lines.push("", stateProtocolText(input.slug));
  }
  // Quiet usage signal (§6.4) — emitted only when the skill actually fires,
  // persisted in history, no status channel needed.
  lines.push("", `Start your reply with "Using ${input.slug}." on its own line.`);
  return lines.join("\n");
}
