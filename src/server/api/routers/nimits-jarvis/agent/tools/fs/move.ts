import { z } from "zod";
import { rename, stat } from "node:fs/promises";
import { zodSchema } from "ai";
import type { Tool } from "ai";
import { resolveWritePath } from "~/server/lib/fs-access/write-paths";
import type { FsToolOptions } from "../index";

/**
 * fs_move — validates BOTH paths through resolveWritePath, refuses when `to`
 * exists, and refuses moves that cross out of the root.
 * B1: auto-executes when Full is selected.
 */
export const fsMoveSchema = z.object({
  from: z.string().describe("Absolute path or ~/relative path of the file to move"),
  to: z.string().describe("Destination path (must not already exist)"),
});

export type FsMoveInput = z.infer<typeof fsMoveSchema>;

export function createFsMoveTool(fs: FsToolOptions): Tool<FsMoveInput, Record<string, unknown>> {
  return {
    description: "Move/rename a file on the operator's Mac. Both paths are validated and destination must not already exist. Requires Full System Access.",
    inputSchema: zodSchema(fsMoveSchema),
    execute: async ({ from, to }) => {
      const rFrom = await resolveWritePath(from, fs.fsRoot, { op: "move" });
      if (!rFrom.ok) return { error: { code: rFrom.error.code, message: rFrom.error.message } };
      const rTo = await resolveWritePath(to, fs.fsRoot, { op: "move" });
      if (!rTo.ok) return { error: { code: rTo.error.code, message: rTo.error.message } };
      if (rFrom.path === rTo.path) {
        return { error: { code: "BAD_MOVE", message: "from and to resolve to the same path." } };
      }
      let toExists = false;
      try {
        await stat(rTo.path);
        toExists = true;
      } catch {}
      if (toExists) {
        return { error: { code: "ALREADY_EXISTS", message: `Destination already exists: ${rTo.path}` } };
      }
      try {
        await rename(rFrom.path, rTo.path);
        return { op: "move", path: rFrom.path, toPath: rTo.path, status: "applied" };
      } catch (e) {
        return { error: { code: "BAD_PATH", message: (e as Error).message } };
      }
    },
  };
}
