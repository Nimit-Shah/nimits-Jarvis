import { z } from "zod";
import { zodSchema } from "ai";
import type { Tool } from "ai";
import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  isDeniedByName,
  mapErrno,
  resolveSafePath,
} from "~/server/lib/fs-access/paths";

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

/** Shared entry budget across root + children so `limit` is a real total cap. */
type Budget = { remaining: number; dirsVisited: number };

interface ListOneResult {
  entries: FsEntry[];
  truncated: boolean;
  totalSeen: number;
  skippedDenied: number;
  skippedHidden: number;
  error?: { code: string; message: string };
}

/** Depth-1/2 listing of one directory. Never throws — returns mapped errors. */
async function listOne(
  dir: string,
  opts: {
    includeHidden: boolean;
    fsRoot: string | null;
    budget: Budget;
  },
): Promise<ListOneResult> {
  const entries: FsEntry[] = [];
  let truncated = false;
  let skippedDenied = 0;
  let skippedHidden = 0;

  opts.budget.dirsVisited++;

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    // A TCC-blocked directory and an empty directory must NOT look the same
    // to the model — surface the mapped errno so it can report the cause.
    const mapped = mapErrno(err, dir);
    if (!mapped.ok) {
      return {
        entries,
        truncated,
        totalSeen: 0,
        skippedDenied,
        skippedHidden,
        error: { code: mapped.code, message: mapped.message },
      };
    }
    return { entries, truncated, totalSeen: 0, skippedDenied, skippedHidden };
  }

  // Real directory size, NOT names-iterated-before-break — a truncated
  // listing that reports 307 for a far larger dir misleads the model into
  // thinking it saw everything.
  const totalSeen = names.length;

  for (const name of names) {
    if (opts.budget.remaining <= 0) {
      truncated = true;
      break;
    }
    if (!opts.includeHidden && name.startsWith(".")) {
      skippedHidden++;
      continue;
    }

    const full = join(dir, name);
    let st;
    try {
      st = await lstat(full);
    } catch {
      // lstat failure (TCC/EPERM on the entry itself) — skip silently
      continue;
    }

    const isLink = st.isSymbolicLink();
    // Non-symlink child of a realpathed parent cannot escape containment, so
    // a cheap string-only deny check is equivalent to resolveSafePath there.
    // Only symlinks need real resolution (they can point anywhere).
    if (isLink) {
      const resolved = await resolveSafePath(full, opts.fsRoot);
      if (!resolved.ok) {
        if (resolved.code === "DENIED_PATH") skippedDenied++;
        continue;
      }
    } else if (isDeniedByName(full, opts.fsRoot)) {
      // Denied entries are skipped silently and only counted — listing their
      // names would leak that credentials exist.
      skippedDenied++;
      continue;
    }

    const type = isLink ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    const entry: FsEntry = {
      name,
      type,
      modifiedAt: st.mtime.toISOString(),
    };
    if (type === "file") entry.sizeBytes = st.size;
    entries.push(entry);
    opts.budget.remaining--;
  }

  // Deterministic: directories first, then files, alphabetical within group
  entries.sort((a, b) => {
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (b.type === "dir" && a.type !== "dir") return 1;
    return a.name.localeCompare(b.name);
  });

  return { entries, truncated, totalSeen, skippedDenied, skippedHidden };
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

      const budget: Budget = { remaining: limit, dirsVisited: 0 };
      const rootListing = await listOne(resolved.path, { includeHidden, fsRoot: fs.fsRoot, budget });
      const result: Record<string, unknown> = {
        path: resolved.path,
        entries: rootListing.entries,
        truncated: rootListing.truncated,
        totalSeen: rootListing.totalSeen,
        skippedDenied: rootListing.skippedDenied,
        skippedHidden: rootListing.skippedHidden,
        budgetExhausted: rootListing.truncated,
        ...(rootListing.error ? { error: rootListing.error } : {}),
      };

      // Depth 2: one extra level of subdirectory expansion (hard-capped at 2).
      // The shared budget makes `limit` a total cap across root + children.
      if (
        depth >= 2 &&
        !rootListing.truncated &&
        budget.remaining > 0
      ) {
        const subdirs = rootListing.entries.filter((e) => e.type === "dir");
        const children: Record<string, unknown> = {};
        for (const sd of subdirs) {
          if (budget.remaining <= 0) {
            result.budgetExhausted = true;
            break;
          }
          const sub = await listOne(join(resolved.path, sd.name), {
            includeHidden,
            fsRoot: fs.fsRoot,
            budget,
          });
          if (sub.truncated) result.budgetExhausted = true;
          children[sd.name] = {
            entries: sub.entries,
            truncated: sub.truncated,
            skippedDenied: sub.skippedDenied,
            skippedHidden: sub.skippedHidden,
            ...(sub.error ? { error: sub.error } : {}),
          };
        }
        result.children = children;
      }

      return result;
    },
  };
}
