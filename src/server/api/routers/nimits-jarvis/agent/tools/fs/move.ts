import { z } from "zod";
import { rename, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { zodSchema } from "ai";
import type { Tool, ToolExecutionOptions } from "ai";
import { resolveWritePath } from "~/server/lib/fs-access/write-paths";
import { backupOriginal } from "~/server/lib/fs-access/journal";
import { readFile } from "node:fs/promises";
import { journalAppliedChange } from "~/server/lib/fs-access/apply-write";
import { MAX_AUTO_WRITES_PER_MESSAGE } from "~/server/lib/fs-access/write-paths";
import type { FsToolOptions } from "../index";

/**
 * fs_move — validates BOTH paths through resolveWritePath, refuses when `to`
 * exists, and refuses moves that cross out of the root.
 * B1: auto-executes when Full is selected. Journaled to FileChange audit log.
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
    execute: async ({ from, to }, options?: ToolExecutionOptions) => {
      const rFrom = await resolveWritePath(from, fs.fsRoot, { op: "move" });
      if (!rFrom.ok) return { error: { code: rFrom.error.code, message: rFrom.error.message } };
      const rTo = await resolveWritePath(to, fs.fsRoot, { op: "move" });
      if (!rTo.ok) return { error: { code: rTo.error.code, message: rTo.error.message } };
      if (rFrom.path === rTo.path) {
        return { error: { code: "BAD_MOVE", message: "from and to resolve to the same path." } };
      }

      if (fs.changeBudget.remaining <= 0) {
        return {
          error: {
            code: "CHANGE_BUDGET_EXCEEDED",
            message: `At most ${MAX_AUTO_WRITES_PER_MESSAGE} file change(s) per message. Further changes require a new message.`,
          },
        };
      }

      let beforeBuf: Buffer | null = null;
      try {
        beforeBuf = await readFile(rFrom.path);
      } catch {
        return { error: { code: "NOT_FOUND", message: `No such file: ${rFrom.path}` } };
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
        // Row id generated here so the pre-rename backup is keyed by the id
        // the FileChange row gets — undo reads journalDirFor(row.id).
        const changeId = randomUUID();
        const backup = await backupOriginal(changeId, rFrom.path).catch(() => null);
        await rename(rFrom.path, rTo.path);

        fs.changeBudget.remaining -= 1;
        await journalAppliedChange({
          instanceId: fs.instanceId,
          chatId: fs.chatId,
          toolCallId: options?.toolCallId ?? "",
          changeId,
          op: "move",
          path: rFrom.path,
          toPath: rTo.path,
          before: beforeBuf,
          after: null,
          backup,
        });

        return { op: "move", path: rFrom.path, toPath: rTo.path, status: "applied" };
      } catch (e) {
        return { error: { code: "BAD_PATH", message: (e as Error).message } };
      }
    },
  };
}