import { z } from "zod";
import { zodSchema } from "ai";
import type { Tool } from "ai";
import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { resolveSafePath } from "~/server/lib/fs-access/paths";

export const fsListSchema = z.object({
  path: z.string().describe("Absolute path or ~/relative path to a directory"),
  depth: z.number().int().min(1).max(2).default(1),
  includeHidden: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(200),
});

export type FsListInput = z.infer<typeof fsListSchema>;

type FsToolOptions = { fsReadEnabled: boolean; fsMode: "read-only" | "full"; fsRoot: string | null };

interface FsEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  sizeBytes?: number;
  modifiedAt: string;
}

/** Depth-1/2 listing of one directory. Never throws — returns mapped errors. */
async function listOne(
  dir: string,
  opts: { includeHidden: boolean; limit: number; fsRoot: string | null },
): Promise<{ entries: FsEntry[]; truncated: boolean; totalSeen: number; skippedDenied: number }> {
  const entries: FsEntry[] = [];
  let totalSeen = 0;
  let skippedDenied = 0;
  let truncated = false;

  let names: string[];
  try {
    names = await import("node:fs/promises").then((fs) => fs.readdir(dir));
  } catch {
    return { entries, truncated, totalSeen, skippedDenied };
  }

  for (const name of names) {
    totalSeen++;
    if (!opts.includeHidden && name.startsWith(".")) continue;

    const full = join(dir, name);
    // resolveSafePath realpaths the entry (following symlinks) and applies the
    // deny-list to the resolved result. Denied entries are skipped silently and
    // only counted — listing their names would leak that credentials exist.
    const resolved = await resolveSafePath(full, opts.fsRoot);
    if (!resolved.ok) {
      if (resolved.code === "DENIED_PATH") skippedDenied++;
      continue;
    }
    try {
      const st = await lstat(full);
      const type = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
      const entry: FsEntry = {
        name,
        type,
        modifiedAt: st.mtime.toISOString(),
      };
      if (type === "file") entry.sizeBytes = st.size;
      entries.push(entry);
    } catch {
      // lstat failure (TCC/EPERM on the entry itself) — skip silently
    }

    if (entries.length >= opts.limit) {
      truncated = true;
      break;
    }
  }

  // Deterministic: directories first, then files, alphabetical within group
  entries.sort((a, b) => {
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (b.type === "dir" && a.type !== "dir") return 1;
    return a.name.localeCompare(b.name);
  });

  return { entries, truncated, totalSeen, skippedDenied };
}

export function createFsListTool(fs: FsToolOptions): Tool<FsListInput, Record<string, unknown>> {
  return {
    description: "List directory contents on the operator's Mac",
    inputSchema: zodSchema(fsListSchema),
    execute: async ({ path, depth = 1, includeHidden = false, limit = 200 }) => {
      const resolved = await resolveSafePath(path, fs.fsRoot);
      if (!resolved.ok) {
        return { error: { code: resolved.code, message: resolved.message } };
      }

      const rootListing = await listOne(resolved.path, { includeHidden, limit, fsRoot: fs.fsRoot });
      const result: Record<string, unknown> = {
        path: resolved.path,
        entries: rootListing.entries,
        truncated: rootListing.truncated,
        totalSeen: rootListing.totalSeen,
        skippedDenied: rootListing.skippedDenied,
      };

      // Depth 2: one extra level of subdirectory expansion (hard-capped at 2)
      if (depth >= 2 && !rootListing.truncated) {
        const subdirs = rootListing.entries.filter((e) => e.type === "dir").slice(0, 25);
        const children: Record<string, unknown> = {};
        for (const sd of subdirs) {
          const sub = await listOne(join(resolved.path, sd.name), { includeHidden, limit: 50, fsRoot: fs.fsRoot });
          children[sd.name] = {
            entries: sub.entries,
            truncated: sub.truncated,
            skippedDenied: sub.skippedDenied,
          };
        }
        result.children = children;
      }

      return result;
    },
  };
}
