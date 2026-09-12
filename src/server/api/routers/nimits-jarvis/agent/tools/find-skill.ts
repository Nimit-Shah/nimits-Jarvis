import { zodSchema } from "ai";
import type { Tool } from "ai";
import {
  searchSkillsCli,
  type RegistryCandidate,
} from "~/server/lib/skills/cli-search";
import { searchSkillsApi } from "~/server/lib/skills/catalog";
import { findSkillSchema, type FindSkillInput } from "./find-skill.schema";

export type FindSkillOutput =
  | { candidates: RegistryCandidate[]; via: "cli" | "api" }
  | { error: { code: string; message: string } };

/**
 * find_skill — read-only registry search, CLI-first with API fallback.
 * The description is the ordering gate (tools → installed skills → outside),
 * same mechanism as load_skill's description. `triedExisting` makes every
 * call self-documenting in the tool-call log.
 *
 * PII: the query leaves for a third-party registry with tokens intact
 * (noArgumentRestore in setup.ts) — never real values. Results are
 * untrusted external content and take the normal redact path.
 */
export function createFindSkillTool(): Tool<
  FindSkillInput,
  FindSkillOutput
> {
  return {
    description:
      "Search skills.sh for a ready-made skill. Only after confirming no ToolSet tool (Composio/MCP) or AVAILABLE SKILLS entry fits. Never browse speculatively.",
    inputSchema: zodSchema(findSkillSchema),
    execute: async ({ query, owner }) => {
      const cli = await searchSkillsCli(query, { owner });
      if (cli.ok) return { candidates: cli.candidates, via: "cli" as const };

      const api = await searchSkillsApi(query, { owner });
      if (api) return { candidates: api, via: "api" as const };

      return {
        error: {
          code: "REGISTRY_UNAVAILABLE",
          message:
            "Skill search is unavailable (CLI failed and no API token). Proceed without external skills.",
        },
      };
    },
  };
}
