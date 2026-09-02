"use client";

import { useEffect, useState } from "react";
import { Check, X, Undo2, FileEdit, AlertTriangle, Loader2 } from "lucide-react";
import { trpc } from "~/clients/trpc";
import { useChatContext } from "../chat-context";
import { useInstanceId } from "~/hooks/use-instance-id";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { CodeBlock } from "./assistant-message/code-block";
import { cn } from "~/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { getToolName } from "ai";

/**
 * Approval card for Phase B write tools (fs_edit/fs_write/fs_delete/fs_mkdir/fs_move).
 * Rendered when the tool part is in input-available state (no-execute tools wait
 * for the client to supply the result). Shows the REAL pre-flight effect — the
 * server-computed diff bound to sha256Before — never the model's intent.
 *
 * Flow: mount → preflightFileChange (idempotent by toolCallId) → card →
 * Approve/Reject → executeFileChange → addToolOutput → model continues.
 */

const FS_WRITE_TOOLS = new Set(["fs_edit", "fs_write", "fs_delete", "fs_mkdir", "fs_move"]);

export function isFsWriteToolPart(part: unknown): part is ToolUIPart | DynamicToolUIPart {
  if (typeof part !== "object" || part === null) return false;
  const p = part as { type?: string; toolName?: string };
  const name = p.type?.startsWith("tool-") ? p.type.slice(5) : p.toolName;
  return name !== undefined && FS_WRITE_TOOLS.has(name);
}

interface FileChangeRow {
  id: string;
  op: string;
  path: string;
  toPath?: string | null;
  sha256Before?: string | null;
  sha256After?: string | null;
  bytesBefore?: number | null;
  bytesAfter?: number | null;
  diff?: string | null;
  status: string;
  rejectReason?: string | null;
  error?: string | null;
}

function formatBytes(n: number): string {
  return n.toLocaleString("en-US");
}

export function FileChangeCard({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const toolCallId = part.toolCallId;
  const toolName = getToolName(part);
  const input = (part as { input?: Record<string, unknown> }).input as Record<string, unknown> | undefined;
  const { addToolOutput, chatId } = useChatContext();
  const [instanceId] = useInstanceId();
  const utils = trpc.useUtils();

  // 1. Run server-side pre-flight ONCE per toolCallId (idempotent upsert)
  const preflight = trpc.nimitsJarvis.preflightFileChange.useMutation({
    onError: () => {
      // surfaced via preflight.error below
    },
  });

  const [row, setRow] = useState<FileChangeRow | null>(null);
  const [shouldPreflight, setShouldPreflight] = useState(true);

  const query = trpc.nimitsJarvis.getFileChange.useQuery(
    { toolCallId },
    { enabled: true },
  );

  useEffect(() => {
    if (query.data && !row) setRow(query.data as FileChangeRow);
  }, [query.data, row]);

  useEffect(() => {
    if (!shouldPreflight || !input || !instanceId || !chatId) return;
    setShouldPreflight(false);
    preflight.mutate(
      {
        instanceId,
        chatId,
        toolCallId,
        op: (toolName.replace("fs_", "") || "write") as "edit" | "write" | "delete" | "mkdir" | "move",
        path: String(input.path ?? input.from ?? ""),
        toPath: input.to ? String(input.to) : undefined,
        oldText: input.oldText !== undefined ? String(input.oldText) : undefined,
        newText: input.newText !== undefined ? String(input.newText) : undefined,
        expectedOccurrences: typeof input.expectedOccurrences === "number" ? input.expectedOccurrences : 1,
        content: input.content !== undefined ? String(input.content) : undefined,
        mode: input.mode === "overwrite" ? "overwrite" : input.mode === "create" ? "create" : undefined,
      },
      {
        onSuccess: (data) => {
          if (data.ok) setRow(data.fileChange as unknown as FileChangeRow);
        },
        onError: () => {
          // keep card visible via preflight.error — user can see the server message
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once when instanceId/chatId/input resolve
  }, [shouldPreflight, instanceId, chatId, input]);

  // 2. Approve / Reject → executeFileChange → addToolOutput
  const execute = trpc.nimitsJarvis.executeFileChange.useMutation({
    onSuccess: (data) => {
      void utils.nimitsJarvis.getFileChange.invalidate({ toolCallId });
      if (data.ok && data.toolResult) {
        addToolOutput({
          tool: toolName as never,
          toolCallId,
          output: data.toolResult as Record<string, unknown>,
        });
      } else {
        addToolOutput({
          tool: toolName as never,
          toolCallId,
          output: {
            status: "failed",
            error: ("error" in data && data.error) || "Execution failed",
          } as Record<string, unknown>,
        });
      }
    },
  });

  const undo = trpc.nimitsJarvis.undoFileChange.useMutation({
    onSuccess: () => {
      void utils.nimitsJarvis.getFileChange.invalidate({ toolCallId });
      addToolOutput({
        tool: toolName as never,
        toolCallId,
        output: { status: "undone", message: "The operator undid this change; the original content was restored." } as Record<string, unknown>,
      });
    },
  });

  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [expanded, setExpanded] = useState(false);

  const status = row?.status ?? "preflight";
  const isPending = status === "pending" || status === "preflight";
  const isStale = status === "stale";
  const applied = status === "applied";
  const undone = status === "undone";
  const rejected = status === "rejected";
  const failed = status === "failed";

  const op = row?.op ?? toolName.replace("fs_", "");
  const byteDelta =
    row?.bytesBefore !== undefined && row?.bytesBefore !== null && row?.bytesAfter !== undefined && row?.bytesAfter !== null
      ? row.bytesAfter - row.bytesBefore
      : null;

  return (
    <div className="border-border/70 my-3 rounded-xl border shadow-sm">
      <div className="flex items-center gap-2 px-3 pt-3">
        <FileEdit className="text-muted-foreground size-4 shrink-0" />
        <span className="text-foreground text-[13px] font-semibold capitalize">
          {op} {op === "move" ? "" : "file"}
        </span>
        {row?.sha256Before && (
          <span className="text-muted-foreground ml-auto font-mono text-[10px]" title="Content digest this approval is bound to">
            sha256:{row.sha256Before.slice(0, 8)}
          </span>
        )}
      </div>

      <div className="space-y-2 px-3 py-2">
        {/* Realpathed absolute target — not the path the model typed */}
        <div className="text-xs">
          <span className="text-muted-foreground">Target: </span>
          <code className="bg-muted/40 rounded px-1 py-0.5 font-mono text-[11px] break-all">{row?.path ?? String(input?.path ?? input?.from ?? "…")}</code>
          {row?.toPath && (
            <>
              <span className="text-muted-foreground"> → </span>
              <code className="bg-muted/40 rounded px-1 py-0.5 font-mono text-[11px] break-all">{row.toPath}</code>
            </>
          )}
        </div>

        {/* Byte delta */}
        {byteDelta !== null && (
          <div className="text-muted-foreground font-mono text-[11px]">
            {formatBytes(row?.bytesBefore ?? 0)} → {formatBytes(row?.bytesAfter ?? 0)}{" "}
            <span className={byteDelta >= 0 ? "text-emerald-600" : "text-red-500"}>
              ({byteDelta >= 0 ? "+" : ""}
              {formatBytes(byteDelta)})
            </span>
          </div>
        )}

        {(op === "write" && row?.bytesBefore === 0) || (row && row.bytesBefore === null && op === "write") ? (
          <span className="inline-block rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600">create</span>
        ) : null}
        {toolName === "fs_write" && input?.mode === "overwrite" && (
          <span className="ml-1 inline-block rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600">overwrite — full diff below</span>
        )}

        {/* Unified diff — real pre-flight result, not model intent */}
        {row?.diff && (
          <div>
            <button onClick={() => setExpanded((e) => !e)} className="text-muted-foreground hover:text-foreground text-[11px] underline">
              {expanded ? "Collapse diff" : "Review diff"}
            </button>
            {expanded && (
              <div className="mt-1 max-h-72 overflow-y-auto rounded-md">
                <CodeBlock>{`diff\n${row.diff}`}</CodeBlock>
              </div>
            )}
          </div>
        )}

        {/* Stale / failed states */}
        {isStale && (
          <div className="flex items-center gap-1.5 text-[12px] text-amber-600">
            <AlertTriangle className="size-3.5" />
            This file changed on disk. Ask Jarvis to re-read it and propose again.
          </div>
        )}
        {failed && <div className="text-destructive text-[12px]">Failed: {row?.error ?? "unknown error"}</div>}
        {rejected && <div className="text-muted-foreground text-[12px]">Rejected{row?.rejectReason ? `: ${row.rejectReason}` : "."}</div>}
        {undone && <div className="text-muted-foreground text-[12px]">Undone — original content restored.</div>}

        {/* Preflight error (no card case: OLD_TEXT_NOT_FOUND etc.) */}
        {preflight.error && !row && (
          <div className="text-destructive text-[12px]">{preflight.error.message}</div>
        )}
      </div>

      {/* Action buttons */}
      {isPending && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
          <Button
            size="sm"
            className="h-8 gap-1.5"
            disabled={execute.isPending || preflight.isPending}
            onClick={() => row && execute.mutate({ fileChangeId: row.id, approve: true })}
          >
            {execute.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Approve
          </Button>
          {!rejectMode ? (
            <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={execute.isPending} onClick={() => setRejectMode(true)}>
              <X className="size-3.5" />
              Reject
            </Button>
          ) : (
            <>
              <Input
                autoFocus
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Optional reason (sent to the model)…"
                className="h-8 max-w-xs text-xs"
                maxLength={500}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={execute.isPending}
                onClick={() => {
                  row && execute.mutate({ fileChangeId: row.id, approve: false, rejectReason: rejectReason.trim() || undefined });
                  setRejectMode(false);
                }}
              >
                Send rejection
              </Button>
              <Button size="sm" variant="ghost" className="h-8" onClick={() => setRejectMode(false)}>
                Cancel
              </Button>
            </>
          )}
        </div>
      )}

      {applied && (
        <div className={cn("flex items-center gap-2 px-3 pb-3")}>
          <span className="text-muted-foreground text-[12px]">Applied.</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-[11px]"
            disabled={undo.isPending}
            onClick={() => row && undo.mutate({ fileChangeId: row.id })}
          >
            {undo.isPending ? <Loader2 className="size-3 animate-spin" /> : <Undo2 className="size-3" />}
            Undo
          </Button>
          {undo.error && <span className="text-destructive text-[11px]">{undo.error.message}</span>}
        </div>
      )}
    </div>
  );
}
