import { z } from "zod";
import { zodSchema } from "ai";
import type { Tool } from "ai";
import { mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveWritePath } from "~/server/lib/fs-access/write-paths";
import { atomicWrite } from "~/server/lib/fs-access/atomic-write";
import { backupOriginal } from "~/server/lib/fs-access/journal";
import { readFile } from "node:fs/promises";
import type { FsToolOptions } from "../index";

/**
 * fs_delete — moves the file to ~/.Trash (collision-safe), never unlink.
 * B1: auto-executes when Full is selected.
 */
export const fsDeleteSchema = z.object({
  path: z.string().describe("Absolute path or ~/relative path to a FILE (directories are refused in v1)"),
});

export type FsDeleteInput = z.infer<typeof fsDeleteSchema>;

export function createFsDeleteTool(fs: FsToolOptions): Tool<FsDeleteInput, Record<string, unknown>> {
  return {
    description: "Move a file on the operator's Mac to the Trash (recoverable via Finder). Files only — directories are refused. Requires Full System Access.",
    inputSchema: zodSchema(fsDeleteSchema),
    execute: async ({ path }) => {
      const resolved = await resolveWritePath(path, fs.fsRoot, { op: "delete" });
      if (!resolved.ok) return { error: { code: resolved.error.code, message: resolved.error.message } };
      try {
        const trashDir = join(homedir(), ".Trash");
        await mkdir(trashDir, { recursive: true });
        const trashPath = join(trashDir, `${basename(resolved.path)}.jarvis-${randomUUID().slice(0, 8)}`);
        await backupOriginal(randomUUID(), resolved.path).catch(() => null);
        await rename(resolved.path, trashPath);
        return { op: "delete", path: resolved.path, trashedTo: trashPath, status: "applied" };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EISDIR" || code === "EPERM") {
          return { error: { code: "NOT_A_FILE", message: "That is a directory — directories cannot be deleted in v1." } };
        }
        return { error: { code: "BAD_PATH", message: (e as Error).message } };
      }
    },
  };
}
