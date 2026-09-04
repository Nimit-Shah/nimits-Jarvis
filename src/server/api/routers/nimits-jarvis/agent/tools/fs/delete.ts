import { z } from "zod";
import { zodSchema } from "ai";
import type { Tool, ToolExecutionOptions } from "ai";
import { mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveWritePath } from "~/server/lib/fs-access/write-paths";
import { backupOriginal } from "~/server/lib/fs-access/journal";
import { readFile } from "node:fs/promises";
import { journalAppliedChange } from "~/server/lib/fs-access/apply-write";
import { unifiedDiff } from "~/server/lib/fs-access/diff";
import { MAX_AUTO_WRITES_PER_MESSAGE } from "~/server/lib/fs-access/write-paths";
import type { FsToolOptions } from "../index";

/**
 * fs_delete — moves the file to ~/.Trash (collision-safe), never unlink.
 * B1: auto-executes when Full is selected. Journaled to FileChange audit log.
 */
export const fsDeleteSchema = z.object({
  path: z.string().describe("Absolute path or ~/relative path to a FILE (directories are refused in v1)"),
});

export type FsDeleteInput = z.infer<typeof fsDeleteSchema>;

export function createFsDeleteTool(fs: FsToolOptions): Tool<FsDeleteInput, Record<string, unknown>> {
  return {
    description: "Move a file on the operator's Mac to the Trash (recoverable via Finder). Files only — directories are refused. Requires Full System Access.",
    inputSchema: zodSchema(fsDeleteSchema),
    execute: async ({ path }, options?: ToolExecutionOptions) => {
      const resolved = await resolveWritePath(path, fs.fsRoot, { op: "delete" });
      if (!resolved.ok) return { error: { code: resolved.error.code, message: resolved.error.message } };

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
        beforeBuf = await readFile(resolved.path);
      } catch {
        return { error: { code: "NOT_FOUND", message: `No such file: ${resolved.path}` } };
      }

      try {
        const trashDir = join(homedir(), ".Trash");
        await mkdir(trashDir, { recursive: true });
        const trashPath = join(trashDir, `${basename(resolved.path)}.jarvis-${randomUUID().slice(0, 8)}`);
        // Row id generated here so the pre-rename backup is keyed by the id
        // the FileChange row gets — undo reads journalDirFor(row.id).
        const changeId = randomUUID();
        const backup = await backupOriginal(changeId, resolved.path).catch(() => null);
        await rename(resolved.path, trashPath);

        fs.changeBudget.remaining -= 1;
        await journalAppliedChange({
          instanceId: fs.instanceId,
          chatId: fs.chatId,
          toolCallId: options?.toolCallId ?? "",
          changeId,
          op: "delete",
          path: resolved.path,
          before: beforeBuf,
          after: null,
          // A delete's diff is the whole file going away.
          diff: unifiedDiff(beforeBuf.toString("utf-8"), ""),
          backup,
        });

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