import { z } from "zod";
import { readFile } from "node:fs/promises";
import { zodSchema } from "ai";
import type { Tool } from "ai";
import { resolveWritePath } from "~/server/lib/fs-access/write-paths";
import { atomicWrite } from "~/server/lib/fs-access/atomic-write";
import type { FsToolOptions } from "../index";

/**
 * fs_write — creates a new file (or overwrites with mode="overwrite").
 * B1 auto-write: executes immediately when Full System Access is selected.
 */
export const fsWriteSchema = z.object({
  path: z.string().describe("Absolute path or ~/relative path for the file"),
  content: z.string().describe("Full file content to write"),
  mode: z.enum(["create", "overwrite"]).default("create"),
});

export type FsWriteInput = z.infer<typeof fsWriteSchema>;

export function createFsWriteTool(fs: FsToolOptions): Tool<FsWriteInput, Record<string, unknown>> {
  return {
    description:
      "Create a new file on the operator's Mac (or overwrite with mode='overwrite'). Requires Full System Access. For existing files, fs_edit is preferred.",
    inputSchema: zodSchema(fsWriteSchema),
    execute: async ({ path, content, mode = "create" }) => {
      const resolved = await resolveWritePath(path, fs.fsRoot, {
        op: "write",
        bytes: Buffer.byteLength(content, "utf-8"),
      });
      if (!resolved.ok) return { error: { code: resolved.error.code, message: resolved.error.message } };

      let exists = false;
      try {
        await readFile(resolved.path);
        exists = true;
      } catch {}

      if (mode === "create" && exists) {
        return { error: { code: "ALREADY_EXISTS", message: `${resolved.path} already exists. Use mode:"overwrite" or fs_edit.` } };
      }

      const buf = Buffer.from(content, "utf-8");
      const { bytesWritten } = await atomicWrite(resolved.path, buf);
      return { op: "write", path: resolved.path, bytesWritten, mode, status: "applied" };
    },
  };
}
