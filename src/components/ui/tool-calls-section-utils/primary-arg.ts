/**
 * Picks the human-meaningful argument for a collapsed tool row — the one value
 * that identifies WHAT the call touches (fs_list ~/pCloud Drive, fs_find
 * "Automatic Upload") instead of dumping JSON.
 *
 * Explicit map per tool, then a generic fallback: first non-empty string value
 * in the input object.
 */

const PRIMARY_ARG_KEYS: Record<string, string[]> = {
  fs_list: ["path"],
  fs_read: ["path"],
  fs_find: ["name"],
  fs_write: ["path"],
  fs_edit: ["path"],
  fs_delete: ["path"],
  fs_mkdir: ["path"],
  fs_move: ["path"],
  memory_search: ["query"],
  memory_save: ["content"],
  schedule: ["title"],
};

export function primaryArg(
  toolName: string,
  input?: Record<string, unknown>,
): string | null {
  if (!input || typeof input !== "object") return null;
  const preferred = PRIMARY_ARG_KEYS[toolName];
  if (preferred) {
    for (const key of preferred) {
      const value = input[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}