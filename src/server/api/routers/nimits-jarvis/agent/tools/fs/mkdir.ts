import { z } from "zod";
import { mkdir, stat } from "node:fs/promises";
import { zodSchema } from "ai";
import type { Tool } from "ai";
import { resolveWritePath } from "~/server/lib/fs-access/write-paths";
import type { FsToolOptions } from "../index";

/**
 * fs_mkdir — creates ONE directory, non-recursive.
 * B1: auto-executes when Full is selected.
 */
export const fsMkdirSchema = z.object({
  path: z.string().describe("Absolute path or ~/relative path for the new directory (parent must already exist)"),
});

export type FsMkdirInput = z.infer<typeof fsMkdirSchema>;

export function createFsMkdirTool(fs: FsToolOptions): Tool<FsMkdirInput, Record<string, unknown>> {
  return {
    description: "Create a single directory on the operator's Mac (parent must already exist — no recursive creation). Requires Full System Access.",
    inputSchema: zodSchema(fsMkdirSchema),
    execute: async ({ path }) => {
      const resolved = await resolveWritePath(path, fs.fsRoot, { op: "mkdir" });
      if (!resolved.ok) return { error: { code: resolved.error.code, message: resolved.error.message } };
      try {
        await mkdir(resolved.path);
        return { op: "mkdir", path: resolved.path, status: "applied" };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return { error: { code: "PARENT_MISSING", message: `Parent directory does not exist for ${resolved.path}. Create the parent first.` } };
        }
        if (code === "EEXIST") {
          return { error: { code: "ALREADY_EXISTS", message: `${resolved.path} already exists.` } };
        }
        return { error: { code: "BAD_PATH", message: (e as Error).message } };
      }
    },
  };
}
