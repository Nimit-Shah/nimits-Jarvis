import { z } from "zod";
import { zodSchema } from "ai";
import type { Tool } from "ai";
import { readdir, lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  isDeniedByName,
  mapErrno,
  resolveSafePath,
} from "~/server/lib/fs-access/paths";
import type { FsToolOptions } from "../index";

export const fsFindSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      "Name to match — case-insensitive substring, or * glob",
    ),
  from: z
    .string()
    .optional()
    .describe("Directory to search from; defaults to home"),
  maxDepth: z.number().int().min(1).max(6).default(4),
  type: z.enum(["file", "dir"]).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export type FsFindInput = z.infer<typeof fsFindSchema>;

/**
 * Wall-clock guard for the whole walk. An unbounded BFS of a home directory
 * hangs the agent turn; the deny-list (node_modules, .git, Library, ...) plus
 * these three caps keep worst-case cost bounded. Default 5s — a tractable
 * depth-4 BFS with denied trees pruned finishes well under this.
 */
const FIND_TIMEOUT_MS = 5_000;
/** Hard ceiling even if a future config raises the default above this. */
const FIND_TIMEOUT_MAX_MS = 15_000;
/** Directory visit cap — independent guard against pathological fan-out. */
const MAX_DIRS_VISITED = 2_000;

const GLOB_STAR = /[*]/;

/** Case-insensitive substring match, or glob when the query contains `*`. */
function makeMatcher(query: string): (name: string) => boolean {
  const lower = query.toLowerCase();
  if (!GLOB_STAR.test(query)) {
    return (name) => name.toLowerCase().includes(lower);
  }
  const pattern = new RegExp(
    "^" +
      query
        .split("*")
        .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
    "i",
  );
  return (name) => pattern.test(name);
}

export function createFsFindTool(fs: FsToolOptions): Tool<FsFindInput, Record<string, unknown>> {
  return {
    description:
      "Find files/folders by name under a directory. Use this before fs_list when you don't know where something is.",
    inputSchema: zodSchema(fsFindSchema),
    execute: async ({ name, from, maxDepth = 4, type, limit = 50 }) => {
      const deadline = Date.now() + Math.min(FIND_TIMEOUT_MS, FIND_TIMEOUT_MAX_MS);
      const matcher = makeMatcher(name);
      // Explicitly searching a dotfile (".env" is denied anyway, but e.g.
      // ".gitconfig") should see hidden entries; a normal name search skips
      // them to keep results relevant.
      const includeHidden = name.startsWith(".");

      const fromResolved = await resolveSafePath(from ?? "~", fs.fsRoot);
      if (!fromResolved.ok) {
        return { error: { code: fromResolved.code, message: fromResolved.message } };
      }

      const matches: Array<Record<string, unknown>> = [];
      let dirsVisited = 0;
      let truncated = false;
      let timedOut = false;

      // Breadth-first: shallow matches are what people mean. A DFS of a home
      // dir descends into whatever is listed first and buries a depth-2 hit
      // under irrelevant subtrees. Queue entries carry their own depth.
      const queue: Array<{ dir: string; depth: number }> = [
        { dir: fromResolved.path, depth: 0 },
      ];

      while (queue.length > 0) {
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        if (Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        if (dirsVisited >= MAX_DIRS_VISITED) {
          truncated = true;
          break;
        }

        const { dir, depth } = queue.shift()!;
        dirsVisited++;

        let names: string[];
        try {
          names = await readdir(dir);
        } catch (err) {
          // Unreadable subtree (TCC/permissions) — skip, keep walking.
          // Only the FROM directory failing is worth reporting explicitly.
          if (dir === fromResolved.path) {
            const mapped = mapErrno(err, dir);
            if (!mapped.ok) {
              return { error: { code: mapped.code, message: mapped.message } };
            }
          }
          continue;
        }

        for (const entry of names) {
          if (matches.length >= limit) {
            truncated = true;
            break;
          }
          if (Date.now() >= deadline) {
            timedOut = true;
            break;
          }
          if (!includeHidden && entry.startsWith(".")) continue;

          const full = join(dir, entry);
          let st;
          try {
            st = await lstat(full);
          } catch {
            continue;
          }

          const isLink = st.isSymbolicLink();
          // Never follow or descend symlinks during the walk — cycles and
          // escapes are resolved away by simply not entering them. Denied
          // directories (node_modules, Library, .git, ...) are never entered,
          // which is what makes a depth-4 BFS of a home directory tractable.
          if (isLink) {
            const resolved = await resolveSafePath(full, fs.fsRoot);
            if (!resolved.ok) continue;
          } else if (isDeniedByName(full, fs.fsRoot)) {
            continue;
          }

          const isDir = st.isDirectory();
          const t = typeOf(isLink, st);
          if (matcher(entry) && (type === undefined || t === type)) {
            const match: Record<string, unknown> = {
              path: relative(fromResolved.path, full),
              type: t,
              modifiedAt: st.mtime.toISOString(),
            };
            if (t === "file") match.sizeBytes = st.size;
            matches.push(match);
          }

          if (isDir && !isLink && depth < maxDepth) {
            queue.push({ dir: full, depth: depth + 1 });
          }
        }
      }

      // If we stopped mid-queue (timeout/dir cap) but never hit the match
      // limit, the walk was cut short — surface it so the model knows the
      // result set may be incomplete.
      if (!timedOut && !truncated && queue.length > 0) {
        timedOut = true;
      }

      return {
        from: fromResolved.path,
        matches,
        truncated,
        timedOut,
        dirsVisited,
      };
    },
  };
}

function typeOf(
  isLink: boolean,
  st: Awaited<ReturnType<typeof lstat>>,
): "file" | "dir" | "symlink" | "other" {
  return isLink ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
}