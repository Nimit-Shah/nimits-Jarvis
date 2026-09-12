import { createMemorySaveTool } from "./memory-save";
import { createMemorySearchTool } from "./memory-search";
import { createScheduleTool } from "./schedule";
import { createFsListTool } from "./fs/list";
import { createFsReadTool } from "./fs/read";
import { createFsFindTool } from "./fs/find";
import { createFsEditTool } from "./fs/edit";
import { createFsWriteTool } from "./fs/write";
import { createFsDeleteTool } from "./fs/delete";
import { createFsMkdirTool } from "./fs/mkdir";
import { createFsMoveTool } from "./fs/move";
import { createReadToolResultTool } from "./read-tool-result";
import { createLoadSkillTool, type LoadSkillContext } from "./load-skill";
import { createFindSkillTool } from "./find-skill";
import { createInstallSkillTool } from "./install-skill";
import { DEFAULT_TIMEZONE } from "~/lib/timezone";
import type { FsAccessMode } from "../types";
export {
  searchMemoriesForContext,
  shouldLookupMemoriesForContext,
} from "./memory-search";

export interface FsToolOptions {
  fsReadEnabled: boolean;
  fsMode: FsAccessMode; // already clamped by resolveFsMode
  fsRoot: string | null; // instance.fsRootPath; null means os.homedir()
  instanceId: string;
  chatId: string;
  /** Per-message auto-write budget (blast-radius). Mutated by each fs write tool. */
  changeBudget: { remaining: number };
  /**
   * Slugs already loaded this turn whose references/ fs_read/fs_list may
   * reach. Absent/empty = skills root fully denied (Phase 2 default).
   * Populated from pinned + loaded skills in Phase 4.
   */
  allowedSkillSlugs?: Set<string>;
}

export function createCustomTools(
  instanceId: string,
  chatId: string,
  userTimezone: string,
  fs?: FsToolOptions,
  skills?: LoadSkillContext & { hasIndex: boolean; source: string },
) {
  return {
    memory_save: createMemorySaveTool(instanceId),
    memory_search: createMemorySearchTool(instanceId),
    schedule: createScheduleTool(instanceId, chatId ?? "", userTimezone),
    read_tool_result: createReadToolResultTool(instanceId),
    // Read-only registry search (CLI-first, API fallback). Always on: it
    // writes nothing and installs nothing — installation is install_skill's
    // reviewed pipeline, never this tool.
    find_skill: createFindSkillTool(),
    // The only skills-related tool: a skill is never a tool. Registered only
    // when the Tier-1 index is non-empty so no-skill turns stay byte-identical.
    ...(skills?.hasIndex ? { load_skill: createLoadSkillTool(skills) } : {}),
    // Registry install reusing the Phase-5 pipeline. Web only: unattended
    // sources have no one to confirm to, so discovery there is pure risk.
    ...(skills?.source === "web"
      ? {
          install_skill: createInstallSkillTool({
            userId: skills.userId,
            instanceId,
            chatId,
            toolNamesRef: skills.toolNamesRef,
          }),
        }
      : {}),
    // Availability filtering — absent from the toolset when disabled, never
    // rejected at runtime. A tool the model cannot see cannot be called.
    ...(fs?.fsReadEnabled
      ? {
          fs_list: createFsListTool(fs),
          fs_find: createFsFindTool(fs),
          fs_read: createFsReadTool(fs),
        }
      : {}),
    // B1 auto-write: when Full System Access is selected, writes execute
    // immediately (no card, no approval blocking). Whole home scope minus
    // system/persistence denies. Tools auto-execute server-side.
    ...(fs?.fsReadEnabled && fs?.fsMode === "full"
      ? {
          fs_edit: createFsEditTool(fs),
          fs_write: createFsWriteTool(fs),
          fs_delete: createFsDeleteTool(fs),
          fs_mkdir: createFsMkdirTool(fs),
          fs_move: createFsMoveTool(fs),
        }
      : {}),
  };
}
