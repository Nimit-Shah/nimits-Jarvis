import { createMemorySaveTool } from "./memory-save";
import { createMemorySearchTool } from "./memory-search";
import { createScheduleTool } from "./schedule";
export { searchMemoriesForContext, shouldLookupMemoriesForContext } from "./memory-search";

export function createCustomTools(instanceId: string, chatId?: string, userTimezone = "UTC") {
  return {
    memory_save: createMemorySaveTool(instanceId),
    memory_search: createMemorySearchTool(instanceId),
    schedule: createScheduleTool(instanceId, chatId ?? "", userTimezone),
  };
}
