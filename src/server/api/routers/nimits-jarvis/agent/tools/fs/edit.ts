import { z } from "zod";
import { readFile } from "node:fs/promises";
import { zodSchema } from "ai";
import type { Tool } from "ai";
import { resolveWritePath } from "~/server/lib/fs-access/write-paths";
import { atomicWrite } from "~/server/lib/fs-access/atomic-write";
import { backupOriginal } from "~/server/lib/fs-access/journal";
import { sha256Buffer } from "~/server/lib/fs-access/diff";
import type { FsToolOptions } from "../index";

/**
 * fs_edit — edits an existing file by exact text replacement.
 * B1 auto-write: when Full System Access is selected, executes immediately
 * without an approval card. Whole home scope minus system/persistence denies.
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
    execute: async ({ path, oldText, newText, expectedOccurrences = 1 }) => {
      const resolved = await resolveWritePath(path, fs.fsRoot, { op: "edit" });
      if (!resolved.ok) return { error: { code: resolved.error.code, message: resolved.error.message } };

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

      // Journal backup before write (for undo)
      try {
        const { randomUUID } = await import("node:crypto");
        const backup = await backupOriginal(randomUUID(), resolved.path);
        void backup;
      } catch {}

      const shaBefore = sha256Buffer(beforeBuf);
      const { bytesWritten } = await atomicWrite(resolved.path, afterBuf);
      const shaAfter = sha256Buffer(afterBuf);

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
