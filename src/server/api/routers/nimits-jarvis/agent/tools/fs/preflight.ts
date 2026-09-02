import { randomUUID } from "node:crypto";
import { db } from "~/server/clients/db";
import { resolveWritePath } from "~/server/lib/fs-access/write-paths";
import { journalDirFor } from "~/server/lib/fs-access/journal";
import { sha256Buffer, unifiedDiff } from "~/server/lib/fs-access/diff";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Server-side pre-flight — runs when the model PROPOSES a write, before any
 * card renders. Computes what the change would actually do (never the model's
 * intent): resolves the write path, reads current content, applies in memory,
 * records sha256Before/After + byte deltas + unified diff, creates the
 * FileChange row (status=pending). Nothing touches disk.
 *
 * If the change cannot be applied, returns an error immediately — no card.
 */
export interface PreFlightParams {
  instanceId: string;
  chatId: string;
  /** The model's streamed tool-call id — keys the FileChange row (idempotent) */
  toolCallId: string;
  fsRoot: string | null;
  op: "edit" | "write" | "delete" | "mkdir" | "move";
  path: string;
  toPath?: string;
  // edit
  oldText?: string;
  newText?: string;
  expectedOccurrences?: number;
  // write
  content?: string;
  mode?: "create" | "overwrite";
}

export interface PreFlightResult {
  ok: boolean;
  toolCallId?: string;
  fileChange?: {
    id: string;
    toolCallId: string;
    op: string;
    path: string;
    toPath?: string;
    sha256Before: string | null;
    sha256After: string | null;
    bytesBefore: number | null;
    bytesAfter: number | null;
    diff: string | null;
    displayDiff: string | null;
    diffTruncated: boolean;
    status: "pending";
  };
  error?: { code: string; message: string };
}

const displayDiff = (diff: string | null) => {
  if (!diff) return { display: null as string | null, truncated: false };
  const lines = diff.split("\n");
  if (lines.length <= 200) return { display: diff, truncated: false };
  return {
    display: [...lines.slice(0, 200), `… [${lines.length - 200} more diff lines — full diff stored]`].join("\n"),
    truncated: true,
  };
};

export async function preFlightFileChange(params: PreFlightParams): Promise<PreFlightResult> {
  const { instanceId, chatId, fsRoot, op, path, toPath, toolCallId } = params;

  const check = { op, bytes: params.content !== undefined ? Buffer.byteLength(params.content, "utf-8") : undefined };
  const resolved = await resolveWritePath(path, fsRoot, check);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const target = resolved.path;

  let resolvedTo: string | undefined;
  if (op === "move" && toPath) {
    const r2 = await resolveWritePath(toPath, fsRoot, check);
    if (!r2.ok) return { ok: false, error: r2.error };
    resolvedTo = r2.path;
  }

  // Current content (null when the file does not exist yet)
  let beforeBuf: Buffer | null = null;
  try {
    beforeBuf = await readFile(target);
  } catch {
    beforeBuf = null;
  }
  const shaBefore = beforeBuf ? sha256Buffer(beforeBuf) : null;
  const bytesBefore = beforeBuf ? beforeBuf.length : null;

  // Apply the proposed change IN MEMORY
  let afterBuf: Buffer | null = null;
  let diff: string | null = null;

  switch (op) {
    case "edit": {
      if (beforeBuf === null) {
        return { ok: false, error: { code: "NOT_FOUND", message: `No such file: ${target}. Use fs_write to create it.` } };
      }
      const beforeText = beforeBuf.toString("utf-8");
      const oldText = params.oldText ?? "";
      const newText = params.newText ?? "";
      if (!oldText || oldText === newText) {
        return { ok: false, error: { code: "BAD_EDIT", message: "oldText must be non-empty and differ from newText." } };
      }
      const occurrences = beforeText.split(oldText).length - 1;
      const expected = params.expectedOccurrences ?? 1;
      if (occurrences === 0) {
        return {
          ok: false,
          error: {
            code: "OLD_TEXT_NOT_FOUND",
            message: `oldText not found in ${target}. Read the file again and copy the exact text including indentation.`,
          },
        };
      }
      if (occurrences !== expected) {
        return {
          ok: false,
          error: {
            code: "OCCURRENCE_MISMATCH",
            message: `oldText matched ${occurrences} time(s) but expectedOccurrences=${expected}. Include more surrounding context to make it unique.`,
          },
        };
      }
      afterBuf = Buffer.from(beforeText.replace(oldText, newText), "utf-8");
      diff = unifiedDiff(beforeText, afterBuf.toString("utf-8"), { fromLabel: target, toLabel: target });
      break;
    }
    case "write": {
      const content = params.content ?? "";
      afterBuf = Buffer.from(content, "utf-8");
      if (params.mode === "overwrite" && beforeBuf !== null) {
        diff = unifiedDiff(beforeBuf.toString("utf-8"), content, { fromLabel: target, toLabel: target });
      } else if (beforeBuf !== null) {
        return { ok: false, error: { code: "ALREADY_EXISTS", message: `${target} already exists. Use mode:"overwrite" (shown as a full diff) or fs_edit.` } };
      }
      break;
    }
    case "delete": {
      if (beforeBuf === null) {
        return { ok: false, error: { code: "NOT_FOUND", message: `No such file: ${target}` } };
      }
      // Deletion diff: whole file removed (content NOT embedded — meta only)
      diff = unifiedDiff(beforeBuf.toString("utf-8"), "", { fromLabel: target, toLabel: "/dev/null" }).split("\n").slice(0, 4).join("\n") + "\n… (entire file removed)";
      break;
    }
    case "mkdir": {
      if (beforeBuf !== null) {
        return { ok: false, error: { code: "ALREADY_EXISTS", message: `${target} already exists.` } };
      }
      break;
    }
    case "move": {
      if (beforeBuf === null) {
        return { ok: false, error: { code: "NOT_FOUND", message: `No such file: ${target}` } };
      }
      if (resolvedTo && resolvedTo === target) {
        return { ok: false, error: { code: "BAD_MOVE", message: "from and to resolve to the same path." } };
      }
      break;
    }
  }

  const shaAfter = afterBuf ? sha256Buffer(afterBuf) : null;
  const bytesAfter = afterBuf ? afterBuf.length : null;
  const { display, truncated } = displayDiff(diff);

  // Persist the after-content in the journal dir (NOT the DB row, NOT the
  // client). Execution reads it back — the client is never trusted to supply
  // content, and the digest binds it. Journal dir keyed by the change id.
  let changeId: string;
  const existing = await db.fileChange.findUnique({ where: { toolCallId }, select: { id: true, status: true } });
  if (existing && existing.status === "pending") {
    // Idempotent re-preflight of the same streamed call — update in place
    changeId = existing.id;
  } else if (existing) {
    return { ok: false, error: { code: "ALREADY_RESOLVED", message: `This change was already ${existing.status}.` } };
  } else {
    changeId = randomUUID();
  }

  if (afterBuf && (op === "edit" || op === "write")) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = journalDirFor(changeId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "after"), afterBuf, { mode: 0o600 });
  }

  const row = existing && existing.status === "pending"
    ? await db.fileChange.update({
        where: { id: changeId },
        data: {
          op,
          path: target,
          toPath: resolvedTo,
          sha256Before: shaBefore,
          sha256After: shaAfter,
          bytesBefore,
          bytesAfter,
          diff: display ?? diff, // store the (possibly truncated) diff for the card
          status: "pending",
        },
      })
    : await db.fileChange.create({
        data: {
          id: changeId,
          instanceId,
          chatId,
          toolCallId,
          op,
          path: target,
          toPath: resolvedTo,
          sha256Before: shaBefore,
          sha256After: shaAfter,
          bytesBefore,
          bytesAfter,
          diff: display ?? diff, // store the (possibly truncated) diff for the card; full diff kept for edit/write under 200 lines
          status: "pending",
        },
      });

  return {
    ok: true,
    toolCallId,
    fileChange: {
      id: row.id,
      toolCallId,
      op,
      path: target,
      toPath: resolvedTo,
      sha256Before: shaBefore,
      sha256After: shaAfter,
      bytesBefore,
      bytesAfter,
      diff,
      displayDiff: display,
      diffTruncated: truncated,
      status: "pending",
    },
  };
}

/** Ensure the journal dir exists eagerly so backup-before-rename never fails. */
export async function ensureJournalDir(changeId: string): Promise<string> {
  const dir = journalDirFor(changeId);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  return dir;
}
