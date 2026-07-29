"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import {
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  Wrench,
  Brain,
} from "lucide-react";
import { getToolName } from "ai";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { cn } from "~/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { parseToolResult } from "../../tool-results/envelope";

type AnyToolUIPart = DynamicToolUIPart | ToolUIPart;

function isErrorTool(toolCall: AnyToolUIPart): boolean {
  if (toolCall.state === "output-error") return true;
  if (toolCall.state !== "output-available") return false;
  const parsed = parseToolResult(toolCall.output);
  if (!parsed) return false;
  return parsed.successful === false || (typeof parsed.error === "string" && parsed.error.length > 0);
}

function getDisplayName(name: string): string {
  const prefixes = ["COMPOSIO_", "RUBE_"];
  for (const prefix of prefixes) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

interface CollapsibleToolSectionProps {
  toolCalls: AnyToolUIPart[];
  reasoningTexts: string[];
  isRunning: boolean;
}

export function CollapsibleToolSection({
  toolCalls,
  reasoningTexts,
  isRunning,
}: CollapsibleToolSectionProps) {
  const [open, setOpen] = useState(isRunning);

  const runningCount = toolCalls.filter(
    (tc) => tc.state === "input-streaming" || tc.state === "input-available",
  ).length;

  const completedCount = toolCalls.length - runningCount;
  const hasErrors = toolCalls.some(isErrorTool);
  const hasReasoning = reasoningTexts.length > 0;
  const allReasoning = reasoningTexts.filter(Boolean).join("\n");

  // Auto-expand when streaming
  useEffect(() => {
    if (isRunning) setOpen(true);
  }, [isRunning]);

  const totalElapsed = useMemo(() => {
    return null;
  }, []);

  const label = isRunning
    ? hasReasoning
      ? "Thinking..."
      : runningCount === 1
        ? "Using a tool..."
        : `Using ${runningCount} tools...`
    : hasReasoning && toolCalls.length === 0
      ? "Thought"
      : toolCalls.length === 1
        ? "Used 1 tool"
        : `Used ${toolCalls.length} tools`;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-left transition-colors hover:bg-muted/40 group">
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-90",
          )}
        />
        {isRunning ? (
          <Loader2 className="size-3 animate-spin text-chart-4" />
        ) : hasErrors ? (
          <XCircle className="size-3 text-destructive" />
        ) : (
          <CheckCircle2 className="size-3 text-chart-2" />
        )}
        <span className="text-[12px] text-muted-foreground">{label}</span>
        {hasErrors && !isRunning && (
          <span className="text-[10px] text-destructive ml-1">(with errors)</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1">
        <div className="space-y-2">
          {/* Reasoning text */}
          {allReasoning && (
            <div className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2">
              <pre className="whitespace-pre-wrap text-[11px] text-muted-foreground/60 leading-relaxed font-sans">
                {allReasoning}
              </pre>
            </div>
          )}

          {/* Tool call cards */}
          {toolCalls.length > 0 && (
            <div className="space-y-1 pl-4 pr-1 pb-2">
              {toolCalls.map((tc) => (
                <ToolCallCard
                  key={tc.toolCallId}
                  toolCall={tc}
                />
              ))}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface ToolCallCardProps {
  toolCall: AnyToolUIPart;
}

function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const name = getToolName(toolCall);
  const displayName = getDisplayName(name);
  const isRunning =
    toolCall.state === "input-streaming" || toolCall.state === "input-available";
  const hasError = isErrorTool(toolCall);
  const isMemoryTool = name === "memory_save" || name === "memory_search";

  const startTimeRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isRunning) {
      setElapsed(Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000)));
      return;
    }
    const interval = setInterval(() => {
      setElapsed(Math.round((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  const [expanded, setExpanded] = useState(false);

  const args = (toolCall.input ?? {}) as Record<string, unknown>;
  const hasArgs = Object.keys(args).length > 0;
  const output = toolCall.state === "output-available" ? toolCall.output : undefined;
  const hasResult = output !== undefined;

  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-1.5 text-[11px] transition-colors cursor-pointer",
        isMemoryTool
          ? "border-teal-500/20 bg-teal-950/10"
          : "border-border/40 bg-muted/20",
        hasError && "border-destructive/20",
      )}
      data-tool-call-id={toolCall.toolCallId}
      onClick={(e) => {
        e.stopPropagation();
        if (hasArgs || hasResult) setExpanded(!expanded);
      }}
    >
      <div className="flex items-center gap-1.5">
        {isRunning ? (
          <Loader2 className={cn("size-3 animate-spin", isMemoryTool ? "text-teal-400" : "text-chart-4")} />
        ) : hasError ? (
          <XCircle className="size-3 text-destructive" />
        ) : isMemoryTool ? (
          <Brain className="size-3 text-teal-400" />
        ) : (
          <Wrench className="size-3 text-muted-foreground/60" />
        )}
        <span className="font-medium text-foreground/80">{displayName}</span>
        {elapsed > 0 && (
          <span className="ml-auto text-[10px] text-muted-foreground/50 tabular-nums">
            {elapsed}s
          </span>
        )}
      </div>
      {expanded && (hasArgs || hasResult) && (
        <div className="mt-1.5 max-h-48 overflow-y-auto rounded border border-border/30 bg-background/50 p-2">
          {hasArgs && (
            <div>
              <span className="text-[10px] font-medium text-chart-4">Args</span>
              <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap text-[10px] text-muted-foreground/70">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {hasResult && (
            <div className={cn(hasArgs && "mt-2 border-t border-border/30 pt-2")}>
              <span className="text-[10px] font-medium text-chart-2">Result</span>
              <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap text-[10px] text-muted-foreground/70">
                {JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
