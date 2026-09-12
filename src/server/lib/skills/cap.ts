import type { ToolSet } from "ai";

export interface SkillCapInput {
  trustTier: string;
  toolsRequired: string[];
}

/**
 * tools_required is a CAP, not documentation (§5.2). While a non-trusted
 * skill is pinned for the turn, available tools are the intersection of the
 * turn's normal ToolSet and the declared lists, plus a small always-on core.
 *
 * - Trusted skills (model-loaded or pinned): no filtering. The operator
 *   reviewed them — that provenance is the defense, and no mid-turn
 *   withdrawal is possible for model-loaded skills.
 * - Verified (pin-only): intersection + core. Pinning is the knowing act
 *   that re-allows declared destructive tools.
 * - Untrusted (pin-only): intersection + core, minus destructive tools.
 * - source !== "web" drops pins before this is ever called (Phase 4), so
 *   cron/telegram turns always arrive with an empty list.
 */
export const SKILL_ALWAYS_ON_TOOLS: ReadonlySet<string> = new Set([
  "memory_save",
  "memory_search",
  "schedule",
  "read_tool_result",
  "load_skill",
]);

const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  "fs_write",
  "fs_edit",
  "fs_delete",
  "fs_mkdir",
  "fs_move",
  "schedule",
]);

export function applySkillToolCap(
  allTools: ToolSet,
  pins: SkillCapInput[],
): ToolSet {
  const constrained = pins.filter((p) => p.trustTier !== "trusted");
  if (constrained.length === 0) return allTools;

  const declared = new Set<string>();
  for (const pin of pins) {
    for (const name of pin.toolsRequired) declared.add(name);
  }
  const readOnly = constrained.some((p) => p.trustTier === "untrusted");

  const capped: ToolSet = {};
  for (const [name, tool] of Object.entries(allTools)) {
    if (SKILL_ALWAYS_ON_TOOLS.has(name)) {
      if (readOnly && DESTRUCTIVE_TOOLS.has(name)) continue;
      capped[name] = tool;
      continue;
    }
    if (!declared.has(name)) continue;
    if (readOnly && DESTRUCTIVE_TOOLS.has(name)) continue;
    capped[name] = tool;
  }
  return capped;
}
