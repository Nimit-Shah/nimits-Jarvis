import { randomUUID } from "node:crypto";
import { db } from "~/server/clients/db";
import { backupOriginal, scheduleJournalGc } from "./journal";
import { sha256Buffer, unifiedDiff } from "./diff";

/**
 * B1 auto-write journaling. Called by every fs write tool AFTER the mutation
 * has already applied (backup happens inside the tool before the atomic
 * rename). Creates a FileChange row with status="applied" so the write is
 * recorded for audit and undo.
 *
 * This is the write audit log — the approval card is gone, but the row is
 * still the only record of what the agent changed on disk. Undo (undoFileChange)
 * reads the journal copy + sha256After bound here.
 */

export type AppliedChangeOp = "edit" | "write" | "delete" | "mkdir" | "move";

export interface JournalAppliedChangeParams {
  instanceId: string;
  chatId: string;
  /** The model's streamed tool-call id — keys the FileChange row (idempotent). */
  toolCallId: string;
  /**
   * Pre-generated row id. REQUIRED to match the backup: tools call
   * backupOriginal(changeId, ...) BEFORE the mutation, and undo reads
   * journalDirFor(row.id) — the row id and the journal dir must be the same id.
   * Omitted only by legacy callers (a fresh id is generated, but the backup
   * then cannot be located by undo).
   */
  changeId?: string;
  op: AppliedChangeOp;
  /** Realpathed absolute target (what the tool actually wrote). */
  path: string;
  toPath?: string;
  /** Original content BEFORE the mutation (null for create/mkdir). */
  before: Buffer | null;
  /** Content written to disk (null for delete/mkdir/move). */
  after: Buffer | null;
  /** Full unified diff for edit/write; null otherwise. */
  diff?: string | null;
  /** backupOriginal result captured by the tool BEFORE the rename. */
  backup: Awaited<ReturnType<typeof backupOriginal>>;
}

export async function journalAppliedChange(params: JournalAppliedChangeParams): Promise<{ changeId: string }> {
  const changeId = params.changeId ?? randomUUID();

  const shaBefore = params.before ? sha256Buffer(params.before) : null;
  const shaAfter = params.after ? sha256Buffer(params.after) : null;
  const bytesBefore = params.before?.length ?? null;
  const bytesAfter = params.after?.length ?? null;
  const diff = params.diff ?? null;

  await db.fileChange.create({
    data: {
      id: changeId,
      instanceId: params.instanceId,
      chatId: params.chatId,
      toolCallId: params.toolCallId,
      op: params.op,
      path: params.path,
      toPath: params.toPath,
      sha256Before: shaBefore,
      sha256After: shaAfter,
      bytesBefore,
      bytesAfter,
      diff,
      status: "applied",
      appliedAt: new Date(),
      backupPath: params.backup?.backupPath ?? null,
    },
  });

  void scheduleJournalGc();
  return { changeId };
}

export { backupOriginal, unifiedDiff, sha256Buffer };