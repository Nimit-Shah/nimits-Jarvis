import { createMemorySaveTool } from "./memory-save";
import { createMemorySearchTool } from "./memory-search";
import { createScheduleTool } from "./schedule";
import { DEFAULT_TIMEZONE } from "~/lib/timezone";
export {
  searchMemoriesForContext,
  shouldLookupMemoriesForContext,
} from "./memory-search";

export function createCustomTools(
  instanceId: string,
  chatId?: string,
  userTimezone = DEFAULT_TIMEZONE,
) {
  return {
    memory_save: createMemorySaveTool(instanceId),
    memory_search: createMemorySearchTool(instanceId),
    schedule: createScheduleTool(instanceId, chatId ?? "", userTimezone),
  };
}
