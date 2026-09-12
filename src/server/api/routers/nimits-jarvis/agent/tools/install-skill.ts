import { zodSchema } from "ai";
import type { Tool } from "ai";
import { db } from "~/server/clients/db";
import {
  cleanupTmp,
  cloneRepo,
  finalizeStagedSkill,
  findSkillSubdir,
  ImportError,
} from "~/server/lib/skills/import-pipeline";
import { materializeSkill } from "~/server/lib/skills/materialize";
import { checkCandidateTrust } from "~/server/lib/skills/trust-check";
import { splitSkillTools } from "./load-skill";
import { installSkillSchema, type InstallSkillInput } from "./install-skill.schema";

export interface InstallSkillContext {
  userId: string;
  instanceId: string;
  chatId: string;
  /** Turn's ToolSet keys (same ref load_skill uses) for toolsMissing. */
  toolNamesRef: { current: string[] };
}

export type InstallSkillOutput =
  | {
      slug: string;
      trustTier: string;
      findings: Array<{ rule: string; detail: string }>;
      trustNotes: string[];
      instructions: string;
      toolsMissing: string[];
      references: string[];
      /** The install is complete but use requires an explicit affirmative reply. */
      confirmationRequired: true;
      confirmationPrompt: string;
    }
  | { error: { code: string; message: string } };

function toError(err: unknown): { error: { code: string; message: string } } {
  if (err instanceof ImportError) {
    return { error: { code: err.code === "CONFLICT" ? "SKILL_EXISTS" : "SKILL_INSTALL_FAILED", message: err.message } };
  }
  return {
    error: {
      code: "SKILL_INSTALL_FAILED",
      message: err instanceof Error ? err.message.slice(0, 300) : "Install failed.",
    },
  };
}

/**
 * install_skill — write path reusing the Phase-5 import pipeline (one code
 * path to audit, never `npx skills add`). Trust check first (audits can
 * disqualify), row lands untrusted + imported + auto-tagged, §5.3 scan runs,
 * and use waits for a recorded affirmative reply — returned, never assumed.
 */
export function createInstallSkillTool(
  ctx: InstallSkillContext,
): Tool<InstallSkillInput, InstallSkillOutput> {
  return {
    description:
      "Install a skill from find_skill results by owner/repo@skill. Lands untrusted; use waits for the user's explicit confirmation.",
    inputSchema: zodSchema(installSkillSchema),
    execute: async ({ source, query, slug }) => {
      const at = source.indexOf("@");
      const repo = at === -1 ? source : source.slice(0, at);
      const skillName = at === -1 ? undefined : source.slice(at + 1);

      // Trust check before touching the network beyond metadata.
      const trust = await checkCandidateTrust({
        slug: skillName ?? repo.replace("/", "-"),
        source,
      });
      if (trust.verdict === "disqualify") {
        return {
          error: { code: "SKILL_UNTRUSTED_SOURCE", message: trust.reasons.join(" ") },
        };
      }

      let tmpBase: string | null = null;
      try {
        const cloned = await cloneRepo(`https://github.com/${repo}.git`);
        tmpBase = cloned.tmpBase;
        const stagedDir = await findSkillSubdir(tmpBase, { name: skillName });
        const finalized = await finalizeStagedSkill({
          userId: ctx.userId,
          stagedDir,
          sourceRepo: `https://github.com/${repo}`,
          sourceRef: cloned.sourceRef,
          slugOverride: slug,
          discoverySource: "auto",
          ...(query ? { discoveryQuery: query } : {}),
        });

        const row = await db.skill.findUniqueOrThrow({
          where: { userId_slug: { userId: ctx.userId, slug: finalized.slug } },
        });
        // Conversational consent starts pending: use requires a recorded
        // affirmative reply next turn (resolveConsentedSkills). Never assumed.
        await db.skillConsent.upsert({
          where: { chatId_slug: { chatId: ctx.chatId, slug: finalized.slug } },
          create: { chatId: ctx.chatId, slug: finalized.slug, status: "pending" },
          update: { status: "pending" },
        });
        const materialized = await materializeSkill(row, {
          chatId: ctx.chatId,
          instanceId: ctx.instanceId,
        });
        if (!materialized.ok) {
          return {
            error: { code: "SKILL_UNREADABLE", message: materialized.reason },
          };
        }
        const required = materialized.materialized.toolsRequired;
        return {
          slug: finalized.slug,
          trustTier: finalized.trustTier,
          findings: finalized.findings,
          trustNotes: trust.reasons,
          instructions: materialized.materialized.instructions,
          toolsMissing: splitSkillTools(required, ctx.toolNamesRef.current).toolsMissing,
          references: materialized.materialized.references,
          confirmationRequired: true as const,
          confirmationPrompt: `Installed "${finalized.slug}" (untrusted) from ${repo}. Present its name, description, source, install count, and any scan flags to the user and ask whether to use it for this task. Proceed only on an explicit affirmative reply.`,
        };
      } catch (err) {
        return toError(err);
      } finally {
        await cleanupTmp(tmpBase);
      }
    },
  };
}
