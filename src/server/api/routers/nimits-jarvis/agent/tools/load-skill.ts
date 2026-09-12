import { zodSchema } from "ai";
import type { Tool } from "ai";
import { db } from "~/server/clients/db";
import { materializeSkill } from "~/server/lib/skills/materialize";
import { stateProtocolText } from "~/server/lib/skills/state";
import { loadSkillSchema, type LoadSkillInput } from "./load-skill.schema";

export interface LoadSkillContext {
  userId: string;
  instanceId: string;
  chatId: string;
  /**
   * Populated with the turn's full ToolSet keys after assembly (setup.ts),
   * before wrapToolExecutors. Lets execute report toolsAvailable/toolsMissing
   * against the actual turn — not a stale snapshot.
   */
  toolNamesRef: { current: string[] };
  /**
   * Shared with FsToolOptions.allowedSkillSlugs: a successful load adds the
   * slug, unlocking references/ for later fs_read calls in the same turn.
   */
  loadedSlugs: Set<string>;
}

export interface LoadSkillOutput {
  slug: string;
  displayName: string;
  version?: string;
  trustTier: string;
  instructions: string;
  toolsAvailable: string[];
  toolsMissing: string[];
  state: unknown;
  /** In-band write protocol, present when the skill keeps state. */
  stateHint: string | null;
  references: string[];
}

/** Split declared tools into present vs absent for loud failure. */
export function splitSkillTools(
  toolsRequired: string[],
  toolNames: string[],
): { toolsAvailable: string[]; toolsMissing: string[] } {
  const present = new Set(toolNames);
  return {
    toolsAvailable: toolsRequired.filter((t) => present.has(t)),
    toolsMissing: toolsRequired.filter((t) => !present.has(t)),
  };
}

const NOT_FOUND = (slug: string) => ({
  error: {
    code: "SKILL_NOT_FOUND",
    message: `No enabled skill named "${slug}". Use a slug from AVAILABLE SKILLS.`,
  },
});

/**
 * load_skill — the ONLY skills-related tool (a skill is never a tool).
 * Loads a trusted skill's full instructions verbatim at the tail of the
 * conversation (cache-safe). Verified/untrusted skills are pin-only and
 * refused here with a message naming the correct path.
 */
export function createLoadSkillTool(
  ctx: LoadSkillContext,
): Tool<LoadSkillInput, LoadSkillOutput | { error: { code: string; message: string } }> {
  return {
    description:
      "Load a skill's full instructions by slug. Call before doing work an AVAILABLE SKILLS entry covers.",
    inputSchema: zodSchema(loadSkillSchema),
    execute: async ({ slug }) => {
      // Ownership is enforced by the compound key — a slug another user owns
      // can never match, so stale clients cannot probe across users.
      const row = await db.skill.findUnique({
        where: { userId_slug: { userId: ctx.userId, slug } },
      });
      if (!row?.enabled) return NOT_FOUND(slug);
      // instanceId null = global to every project for this user.
      const scopedTo = row.instanceId;
      if (typeof scopedTo === "string" && scopedTo !== ctx.instanceId) {
        return NOT_FOUND(slug);
      }
      if (row.trustTier !== "trusted") {
        return {
          error: {
            code: "SKILL_PIN_REQUIRED",
            message: `Skill "${slug}" is ${row.trustTier}: it cannot be auto-loaded. Pin it from the composer menu to use it.`,
          },
        };
      }

      const materialized = await materializeSkill(row, {
        chatId: ctx.chatId,
        instanceId: ctx.instanceId,
      });
      if (!materialized.ok) {
        return {
          error: { code: "SKILL_UNREADABLE", message: materialized.reason },
        };
      }
      const { instructions, toolsRequired, references, state } =
        materialized.materialized;

      const { toolsAvailable, toolsMissing } = splitSkillTools(
        toolsRequired,
        ctx.toolNamesRef.current,
      );

      await db.skill.update({
        where: { id: row.id },
        data: { lastUsedAt: new Date(), useCount: { increment: 1 } },
      });
      // Unlock references/ for later fs_read calls in this same turn.
      ctx.loadedSlugs.add(row.slug);

      return {
        slug: row.slug,
        displayName: row.displayName,
        version: row.version ?? undefined,
        trustTier: row.trustTier,
        instructions,
        toolsAvailable,
        toolsMissing,
        state,
        stateHint:
          row.stateScope === "session" || row.stateScope === "persistent"
            ? stateProtocolText(row.slug)
            : null,
        references,
      };
    },
  };
}
