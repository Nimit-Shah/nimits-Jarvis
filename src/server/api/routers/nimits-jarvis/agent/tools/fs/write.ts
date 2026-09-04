import { z } from "zod";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { zodSchema } from "ai";
import type { Tool, ToolExecutionOptions } from "ai";
import { resolveWritePath } from "~/server/lib/fs-access/write-paths";
import { atomicWrite } from "~/server/lib/fs-access/atomic-write";
import { backupOriginal } from "~/server/lib/fs-access/journal";
import { sha256Buffer, unifiedDiff } from "~/server/lib/fs-access/diff";
import { journalAppliedChange } from "~/server/lib/fs-access/apply-write";
import { MAX_AUTO_WRITES_PER_MESSAGE } from "~/server/lib/fs-access/write-paths";
import type { FsToolOptions } from "../index";

/**
 * fs_write — creates a new file (or overwrites with mode="overwrite").
 * B1 auto-write: executes immediately when Full System Access is selected.
 * Journaled to the FileChange audit log (status applied).
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
    execute: async ({ path, content, mode = "create" }, options?: ToolExecutionOptions) => {
      const resolved = await resolveWritePath(path, fs.fsRoot, {
        op: "write",
        bytes: Buffer.byteLength(content, "utf-8"),
      });
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
        beforeBuf = null;
      }

      if (mode === "create" && beforeBuf !== null) {
        return { error: { code: "ALREADY_EXISTS", message: `${resolved.path} already exists. Use mode:"overwrite" or fs_edit.` } };
      }

      const buf = Buffer.from(content, "utf-8");
      // Row id generated here so the pre-rename backup (overwrite only) is
      // keyed by the id the FileChange row gets — undo reads journalDirFor(row.id).
      const changeId = randomUUID();
      const backup = beforeBuf !== null ? await backupOriginal(changeId, resolved.path).catch(() => null) : null;

      const diff =
        beforeBuf !== null ? unifiedDiff(beforeBuf.toString("utf-8"), content) : null;

      const { bytesWritten } = await atomicWrite(resolved.path, buf);

      fs.changeBudget.remaining -= 1;
      await journalAppliedChange({
        instanceId: fs.instanceId,
        chatId: fs.chatId,
        toolCallId: options?.toolCallId ?? "",
        changeId,
        op: "write",
        path: resolved.path,
        before: beforeBuf,
        after: buf,
        diff,
        backup,
      });

      return { op: "write", path: resolved.path, bytesWritten, mode, status: "applied" };
    },
  };
}