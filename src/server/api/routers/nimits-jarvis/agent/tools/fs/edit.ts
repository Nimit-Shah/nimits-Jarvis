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
 * fs_edit — edits an existing file by exact text replacement.
 * B1 auto-write: when Full System Access is selected, executes immediately
 * without an approval card. Whole home scope minus system/persistence denies.
 * Each applied change is journaled to the FileChange audit log (status applied)
 * so undo + audit remain possible with the card gone.
 */
export const fsEditSchema = z.object({
  path: z.string().describe("Absolute path or ~/relative path to an existing file"),
  oldText: z.string().min(1).describe("Exact existing text to replace, including indentation"),
  newText: z.string().describe("Replacement text. Empty string deletes the matched range."),
  expectedOccurrences: z.number().int().min(1).default(1),
});

export type FsEditInput = z.infer<typeof fsEditSchema>;

export function createFsEditTool(fs: FsToolOptions): Tool<FsEditInput, Record<string, unknown>> {
  return {
    description:
      "Edit an existing file on the operator's Mac by exact text replacement. Requires Full System Access. Prefer this over fs_write for existing files.",
    inputSchema: zodSchema(fsEditSchema),
    execute: async ({ path, oldText, newText, expectedOccurrences = 1 }, options?: ToolExecutionOptions) => {
      const resolved = await resolveWritePath(path, fs.fsRoot, { op: "edit" });
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
        return { error: { code: "NOT_FOUND", message: `No such file: ${resolved.path}. Use fs_write to create it.` } };
      }

      const beforeText = beforeBuf.toString("utf-8");
      if (!oldText || oldText === newText) {
        return { error: { code: "BAD_EDIT", message: "oldText must be non-empty and differ from newText." } };
      }
      const occurrences = beforeText.split(oldText).length - 1;
      if (occurrences === 0) {
        return { error: { code: "OLD_TEXT_NOT_FOUND", message: `oldText not found in ${resolved.path}. Read the file again and copy the exact text including indentation.` } };
      }
      if (occurrences !== expectedOccurrences) {
        return { error: { code: "OCCURRENCE_MISMATCH", message: `oldText matched ${occurrences} time(s) but expectedOccurrences=${expectedOccurrences}. Include more surrounding context.` } };
      }

      const afterBuf = Buffer.from(beforeText.replace(oldText, newText), "utf-8");
      if (afterBuf.length > 1_000_000) {
        return { error: { code: "TOO_LARGE", message: "Resulting file exceeds 1 MB limit." } };
      }

      // Row id is generated HERE so the journal backup (taken before the
      // atomic rename) is keyed by the same id the FileChange row gets —
      // undo reads journalDirFor(row.id).
      const changeId = randomUUID();
      const backup = await backupOriginal(changeId, resolved.path).catch(() => null);

      const shaBefore = sha256Buffer(beforeBuf);
      const diff = unifiedDiff(beforeBuf.toString("utf-8"), afterBuf.toString("utf-8"));
      const { bytesWritten } = await atomicWrite(resolved.path, afterBuf);
      const shaAfter = sha256Buffer(afterBuf);

      fs.changeBudget.remaining -= 1;
      await journalAppliedChange({
        instanceId: fs.instanceId,
        chatId: fs.chatId,
        toolCallId: options?.toolCallId ?? "",
        changeId,
        op: "edit",
        path: resolved.path,
        before: beforeBuf,
        after: afterBuf,
        diff,
        backup,
      });

      return {
        op: "edit",
        path: resolved.path,
        bytesWritten,
        sha256Before: shaBefore.slice(0, 8),
        sha256After: shaAfter.slice(0, 8),
        status: "applied",
      };
    },
  };
}