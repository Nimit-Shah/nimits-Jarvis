import { createMemorySaveTool } from "./memory-save";
import { createMemorySearchTool } from "./memory-search";
import { createScheduleTool } from "./schedule";
import { createFsListTool } from "./fs/list";
import { createFsReadTool } from "./fs/read";
import { createFsEditTool } from "./fs/edit";
import { createFsWriteTool } from "./fs/write";
import { createFsDeleteTool } from "./fs/delete";
import { createFsMkdirTool } from "./fs/mkdir";
import { createFsMoveTool } from "./fs/move";
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
}

export function createCustomTools(
  instanceId: string,
  chatId: string,
  userTimezone: string,
  fs?: FsToolOptions,
) {
  return {
    memory_save: createMemorySaveTool(instanceId),
    memory_search: createMemorySearchTool(instanceId),
    schedule: createScheduleTool(instanceId, chatId ?? "", userTimezone),
    // Availability filtering — absent from the toolset when disabled, never
    // rejected at runtime. A tool the model cannot see cannot be called.
    ...(fs?.fsReadEnabled
      ? { fs_list: createFsListTool(fs), fs_read: createFsReadTool(fs) }
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
