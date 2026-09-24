"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Loader2,
  XCircle,
} from "lucide-react";
import { cn } from "~/lib/utils";
import {
  formatToolName,
  getToolCategory,
} from "./tool-calls-section-utils/tool-icons";
import { CompactMarkdown } from "./tool-calls-section-utils/compact-markdown";
import { ToolIcon } from "./tool-calls-section-utils/icons";
import {
  extractGloss,
  stripSummaryLine,
} from "./tool-calls-section-utils/reasoning-gloss";
import { primaryArg } from "./tool-calls-section-utils/primary-arg";
import { TextShimmer } from "./text-shimmer";

// ============================================================================
// Types
// ============================================================================

export interface ToolCallEntry {
  tool_name: string;
  tool_category: string;
  message?: string;
  show_category?: boolean;
  tool_call_id?: string;
  inputs?: Record<string, unknown>;
  output?: string;
  integration_name?: string;
  display_name?: string;
  state?:
    "input-streaming" | "input-available" | "output-available" | "output-error";
}

export interface ToolCallsSectionProps {
  toolCalls: ToolCallEntry[];
  reasoningTexts?: string[];
  chainItems?: Array<
    | { type: "reasoning"; text: string; gloss?: string }
    | { type: "tool-call"; entry: ToolCallEntry }
  >;
  maxIconsToShow?: number;
  defaultExpanded?: boolean;
  className?: string;
  iconSize?: number;
  isStreaming?: boolean;
}

type ChainItem = NonNullable<ToolCallsSectionProps["chainItems"]>[number];

/**
 * Cap on the RENDERED tool output inside the expanded panel. A 15k-character
 * <pre> inside a (virtualised) chat bubble is what makes the message list
 * jank; the full text stays reachable via the copy button.
 */
const MAX_RENDERED_OUTPUT_CHARS = 4_000;

/**
 * Adaptive viewport cap for the expanded reasoning/tool-call list. Short
 * content keeps its natural height; content past 288px scrolls inside the
 * container so long transcripts never push the page/output down.
 */
const EXPANDED_VIEWPORT_CLASS = "max-h-72";

/**
 * Clipboard write with a legacy fallback. `navigator.clipboard.writeText`
 * rejects outside secure contexts (plain http, some iframes) and the
 * failure used to be silent — nothing landed on the clipboard.
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ============================================================================
// Main Component
// ============================================================================

export function ToolCallsSection({
  toolCalls,
  reasoningTexts = [],
  chainItems,
  maxIconsToShow = 10,
  defaultExpanded = false,
  className,
  iconSize = 20,
  isStreaming,
}: ToolCallsSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [expandedCalls, setExpandedCalls] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [copiedIndex, setCopiedIndex] = useState<string | null>(null);

  const toggleCallExpansion = useCallback((key: string) => {
    setExpandedCalls((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleGroupExpansion = useCallback((index: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const handleCopy = useCallback((call: ToolCallEntry, key: string) => {
    const data = {
      tool: call.tool_name,
      inputs: call.inputs,
      output: call.output,
    };
    void copyTextToClipboard(JSON.stringify(data, null, 2)).then((ok) => {
      if (!ok) return;
      setCopiedIndex(key);
      setTimeout(() => setCopiedIndex(null), 2000);
    });
  }, []);

  // Deduplicate icons by category for stacked view
  const uniqueIcons = useMemo(() => {
    const seen = new Set<string>();
    return toolCalls.filter((call) => {
      const cat = getToolCategory(call.tool_name);
      if (seen.has(cat)) return false;
      seen.add(cat);
      return true;
    });
  }, [toolCalls]);

  const displayIcons = uniqueIcons.slice(0, maxIconsToShow);
  const extraCount = uniqueIcons.length - maxIconsToShow;

  const hasErrors = toolCalls.some((c) => c.state === "output-error");
  // A settled stream leaves lingering input-* parts on interrupted runs —
  // never spin those; only show loaders while the chat is still streaming.
  const streamSettled = isStreaming === false;
  const pendingCount = toolCalls.filter(
    (c) => c.state === "input-streaming" || c.state === "input-available",
  ).length;
  const isRunning = pendingCount > 0 && !streamSettled;
  const interruptedCount = streamSettled ? pendingCount : 0;
  const hasInterrupted = interruptedCount > 0;

  // --- Collapsed state machine (Claude.ai-inspired) ---
  const runningTools = useMemo(
    () =>
      toolCalls.filter(
        (c) => c.state === "input-streaming" || c.state === "input-available",
      ),
    [toolCalls],
  );

  const lastReasoningGloss = useMemo(() => {
    if (chainItems && chainItems.length > 0) {
      for (let i = chainItems.length - 1; i >= 0; i--) {
        const item = chainItems[i]!;
        if (item.type === "reasoning")
          return extractGloss(
            (item as { gloss?: string; text: string }).gloss ?? item.text,
          );
      }
    }
    if (reasoningTexts.length > 0)
      return extractGloss(reasoningTexts[reasoningTexts.length - 1]!);
    return null;
  }, [chainItems, reasoningTexts]);

  const mostRecentGloss = useMemo(() => {
    if (!chainItems || chainItems.length === 0) return null;
    const last = chainItems[chainItems.length - 1]!;
    if (last.type === "reasoning")
      return extractGloss(
        (last as { gloss?: string; text: string }).gloss ?? last.text,
      );
    return null;
  }, [chainItems]);

  const aggregatedSummary = useMemo(() => {
    if (toolCalls.length === 0) return "";
    const seen = new Set<string>();
    const names: string[] = [];
    for (const c of toolCalls) {
      const display = c.display_name || formatToolName(c.tool_name);
      const key = display.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        names.push(display);
      }
    }
    if (names.length === 0)
      return `Used ${toolCalls.length} tool${toolCalls.length > 1 ? "s" : ""}`;
    // Dynamic fit to one line: try 5, fall back to 4, 3, 2 to avoid wrapping on long names
    const build = (n: number) =>
      names.length <= n
        ? `Used ${names.join(", ")}`
        : `Used ${names.slice(0, n).join(", ")} and more`;
    for (let n = 5; n >= 2; n--) {
      if (build(n).length <= 58) return build(n);
    }
    return `Used ${names[0]} and more`;
  }, [toolCalls]);

  const { collapsedLabel, showLoader } = useMemo(() => {
    // Reasoning-only turn (no tools): always show gloss
    if (toolCalls.length === 0) {
      return {
        collapsedLabel: lastReasoningGloss ?? "Thinking",
        showLoader: false,
      };
    }
    if (isRunning) {
      // Most recent item is reasoning → show its gloss (State 0, interleaved)
      if (mostRecentGloss)
        return { collapsedLabel: mostRecentGloss, showLoader: false };
      if (runningTools.length > 0) {
        // State 1: single tool initiated → machine name, with loader
        if (runningTools.length === 1) {
          const raw = runningTools[0]!.tool_name;
          return { collapsedLabel: `Used ${raw}`, showLoader: true };
        }
        // State 2: multiple concurrent → count
        return {
          collapsedLabel: `Used ${runningTools.length} tools`,
          showLoader: true,
        };
      }
      // Fallback between tools: show last gloss if any
      if (lastReasoningGloss)
        return { collapsedLabel: lastReasoningGloss, showLoader: false };
      return {
        collapsedLabel: `Used ${toolCalls.length} tools`,
        showLoader: true,
      };
    }
    // Settled mid-tool: run stopped before outputs arrived — no spinner.
    if (hasInterrupted) {
      return {
        collapsedLabel: `${aggregatedSummary || `Used ${toolCalls.length} tools`} — interrupted`,
        showLoader: false,
      };
    }
    // State 3 — turn complete: always end on tools aggregate (not gloss)
    if (hasErrors) {
      // Show failed tool machine name if single failure, else aggregate with — failed
      const failed = toolCalls.filter((c) => c.state === "output-error");
      if (failed.length === 1)
        return {
          collapsedLabel: `Used ${failed[0]!.tool_name} — failed`,
          showLoader: false,
        };
      return {
        collapsedLabel: `${aggregatedSummary} — failed`,
        showLoader: false,
      };
    }
    return {
      collapsedLabel: aggregatedSummary || `Used ${toolCalls.length} tools`,
      showLoader: false,
    };
  }, [
    toolCalls,
    runningTools,
    isRunning,
    hasInterrupted,
    lastReasoningGloss,
    mostRecentGloss,
    aggregatedSummary,
    hasErrors,
  ]);

  const isStreamingEffective = isStreaming ?? isRunning;
  const shouldShimmer = isStreamingEffective && !streamSettled;

  // --- Ordered render nodes: interleave reasoning, group consecutive tool runs ---
  const items: ChainItem[] = useMemo(() => {
    if (chainItems && chainItems.length > 0) return chainItems;
    return [
      ...reasoningTexts.map((text) => ({ type: "reasoning" as const, text })),
      ...toolCalls.map((entry) => ({ type: "tool-call" as const, entry })),
    ];
  }, [chainItems, reasoningTexts, toolCalls]);

  type RenderNode =
    | { kind: "item"; item: ChainItem }
    | { kind: "group"; entries: ToolCallEntry[] };

  const renderNodes: RenderNode[] = useMemo(() => {
    const nodes: RenderNode[] = [];
    let i = 0;
    while (i < items.length) {
      const item = items[i]!;
      if (item.type !== "tool-call") {
        nodes.push({ kind: "item", item });
        i++;
        continue;
      }
      // Runs of ≥2 consecutive tool calls collapse into one "N tool calls" row —
      // most of what makes a multi-call transcript scannable.
      let j = i;
      while (j < items.length && items[j]!.type === "tool-call") j++;
      if (j - i >= 2) {
        nodes.push({
          kind: "group",
          entries: items
            .slice(i, j)
            .map((x) => (x as { entry: ToolCallEntry }).entry),
        });
        i = j;
      } else {
        nodes.push({ kind: "item", item });
        i++;
      }
    }
    return nodes;
  }, [items]);

  const callKey = (call: ToolCallEntry, index: number) =>
    call.tool_call_id ?? `${call.tool_name}-${index}`;

  const renderToolRow = (call: ToolCallEntry, key: string, isLast: boolean) => {
    const cat = getToolCategory(call.tool_name);
    const displayName = call.display_name || formatToolName(call.tool_name);
    const arg = primaryArg(call.tool_name, call.inputs);
    const hasDetails = call.inputs || call.output;
    const k = `${key}:${call.tool_call_id ?? displayName}`;
    const isCallExpanded = expandedCalls.has(k);
    const isCallPending =
      call.state === "input-streaming" || call.state === "input-available";
    const isCallRunning = isCallPending && !streamSettled;
    const isCallInterrupted = isCallPending && streamSettled;
    const isCallError = call.state === "output-error" || isCallInterrupted;

    // Rendered output cap: full text stays behind the copy button.
    const output = call.output;
    const outputInfo =
      call.output && call.output.length > MAX_RENDERED_OUTPUT_CHARS
        ? {
            text: call.output.slice(0, MAX_RENDERED_OUTPUT_CHARS),
            total: call.output.length,
            truncated: true as const,
          }
        : call.output
          ? {
              text: call.output,
              total: call.output.length,
              truncated: false as const,
            }
          : null;

    return (
      <div key={`${k}-row`} className="flex items-stretch gap-2">
        <div className="flex flex-col items-center self-stretch">
          <div className="flex min-h-7 min-w-7 shrink-0 items-center justify-center">
            {isCallRunning ? (
              <Loader2 className="text-chart-4 size-4 animate-spin" />
            ) : isCallError ? (
              <XCircle className="text-destructive size-4" />
            ) : (
              <ToolIcon category={cat} size={20} className="rounded-md" />
            )}
          </div>
          {!isLast && <div className="bg-border/40 min-h-3 w-px flex-1" />}
        </div>
        <div className="min-w-0 flex-1 pb-2">
          <div
            className={cn(
              "flex min-w-0 items-center gap-1 rounded-md px-2 py-1",
              isCallError && "border-destructive/50 bg-destructive/5 border",
            )}
          >
            <button
              type="button"
              className={cn(
                "group/tool flex min-w-0 items-center gap-1.5",
                hasDetails && "cursor-pointer",
              )}
              onClick={() => hasDetails && toggleCallExpansion(k)}
            >
              <span
                className={cn(
                  "group-hover/tool:text-foreground shrink-0 text-[12px] font-medium transition-colors",
                  isCallError ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {isCallInterrupted
                  ? `Interrupted: ${displayName}`
                  : isCallError
                    ? call.message || `Failed: ${displayName}`
                    : displayName}
              </span>
              {/* Primary argument only — no JSON in the collapsed state */}
              {!isCallError && arg && (
                <span className="text-muted-foreground/60 min-w-0 truncate text-[11px]">
                  {arg}
                </span>
              )}
              {hasDetails && (
                <ChevronDown
                  className={cn(
                    "text-muted-foreground/50 size-3 shrink-0 transition-transform duration-150",
                    isCallExpanded && "rotate-180",
                  )}
                />
              )}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleCopy(call, k);
              }}
              className="text-muted-foreground/40 hover:text-muted-foreground ml-auto shrink-0 opacity-0 transition-opacity group-hover/tool:opacity-100"
            >
              {copiedIndex === k ? (
                <Check className="text-chart-2 size-3" />
              ) : (
                <Copy className="size-3" />
              )}
            </button>
          </div>
          {isCallExpanded && hasDetails && (
            <div
              className={cn(
                "mt-1.5 max-h-80 overflow-y-auto overscroll-contain rounded-lg border p-2.5",
                isCallError
                  ? "border-destructive/30 bg-destructive/5"
                  : "border-border/30 bg-muted/20",
              )}
            >
              {call.inputs && Object.keys(call.inputs).length > 0 && (
                <div className="relative">
                  <div className="flex items-center justify-between">
                    <span className="text-chart-4 text-[10px] font-medium">
                      Input
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyTextToClipboard(
                          JSON.stringify(call.inputs, null, 2),
                        );
                      }}
                      className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                    >
                      <Copy className="size-3" />
                    </button>
                  </div>
                  <CompactMarkdown content={call.inputs} />
                </div>
              )}
              {outputInfo && (
                <div
                  className={cn(
                    call.inputs && "mt-2 border-t pt-2",
                    isCallError ? "border-destructive/30" : "border-border/30",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={cn(
                        "text-[10px] font-medium",
                        isCallError ? "text-destructive" : "text-chart-2",
                      )}
                    >
                      {isCallError ? "Error" : "Output"}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (call.output) void copyTextToClipboard(call.output);
                      }}
                      className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                    >
                      <Copy className="size-3" />
                    </button>
                  </div>
                  <CompactMarkdown content={outputInfo.text} />
                  {outputInfo.truncated && (
                    <p className="text-muted-foreground/50 mt-1 text-[10px]">
                      showing first {MAX_RENDERED_OUTPUT_CHARS.toLocaleString()}{" "}
                      of {outputInfo.total.toLocaleString()} characters — full
                      text behind the copy button
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  const listRef = useRef<HTMLDivElement | null>(null);

  // Lightweight content signature so the stick-to-bottom effect re-fires
  // whenever streamed reasoning/tool output grows.
  const contentSignature = useMemo(() => {
    let chars = 0;
    for (const node of renderNodes) {
      if (node.kind === "item") {
        const item = node.item;
        chars +=
          item.type === "reasoning"
            ? item.text.length
            : item.entry.tool_name.length + (item.entry.output?.length ?? 0);
      } else {
        for (const entry of node.entries) {
          chars += entry.tool_name.length + (entry.output?.length ?? 0);
        }
      }
    }
    return `${renderNodes.length}:${chars}`;
  }, [renderNodes]);

  // Stick the expanded viewport to the latest content while it grows.
  // Only the inner container scrolls — the page never jumps.
  useEffect(() => {
    const el = listRef.current;
    if (!el || !isExpanded) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [isExpanded, contentSignature]);

  // Early return AFTER all hooks — returning before them changes hook order
  // when a message transitions empty→non-empty (rules-of-hooks).
  if (toolCalls.length === 0 && reasoningTexts.length === 0) return null;

  return (
    <div className={cn("w-fit max-w-[40rem]", className)}>
      {/* Collapsible Header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="text-muted-foreground hover:text-foreground flex min-w-0 cursor-pointer items-center gap-2 py-2 transition-colors"
      >
        {/* Stacked icons — hidden for reasoning-only turns per spec */}
        {toolCalls.length > 0 && (
          <div className="flex min-h-7 items-center -space-x-1.5">
            {displayIcons.map((call, i) => {
              const cat = getToolCategory(call.tool_name);
              const isFailedIcon = call.state === "output-error";
              return (
                <div
                  key={`${call.tool_name}-${i}`}
                  className={cn(
                    "relative flex size-6 min-w-6 items-center justify-center rounded-md",
                    isFailedIcon &&
                      "ring-destructive/50 bg-destructive/10 ring-1",
                  )}
                  style={{
                    rotate:
                      displayIcons.length > 1
                        ? i % 2 === 0
                          ? "6deg"
                          : "-6deg"
                        : "0deg",
                    zIndex: i,
                  }}
                >
                  <ToolIcon category={cat} size={20} className="rounded-md" />
                </div>
              );
            })}
            {extraCount > 0 && (
              <div className="bg-muted text-muted-foreground z-0 flex size-5 min-h-5 min-w-5 items-center justify-center rounded-md text-[10px]">
                +{extraCount}
              </div>
            )}
          </div>
        )}

        {/* Status loader / error */}
        {showLoader ? (
          <Loader2 className="text-chart-4 size-3 animate-spin" />
        ) : hasErrors ? (
          <XCircle className="text-destructive size-3" />
        ) : null}

        {shouldShimmer ? (
          <TextShimmer
            as="span"
            duration={1}
            spread={2}
            className="truncate text-[12px] font-medium whitespace-nowrap"
          >
            {collapsedLabel}
          </TextShimmer>
        ) : (
          <span
            className={cn(
              "truncate text-[12px] font-medium whitespace-nowrap",
              hasErrors && "text-destructive",
            )}
          >
            {collapsedLabel}
          </span>
        )}

        <ChevronDown
          className={cn(
            "text-muted-foreground size-3.5 transition-transform duration-200",
            isExpanded && "rotate-180",
          )}
        />
      </button>

      {/* Expandable Content — adaptive height, capped viewport, inner scroll */}
      <div
        className={cn(
          "overflow-hidden transition-all duration-200",
          isExpanded
            ? `${EXPANDED_VIEWPORT_CLASS} opacity-100`
            : "max-h-0 opacity-0",
        )}
      >
        <div
          ref={listRef}
          className="max-h-72 space-y-0 overflow-y-auto overscroll-contain pt-1"
        >
          {renderNodes.map((node, nodeIdx) => {
            const isLast = nodeIdx === renderNodes.length - 1;

            if (node.kind === "item" && node.item.type === "reasoning") {
              const item = node.item;
              // Collapsed shows gloss (1 line); expanded shows gloss bold + full paragraph
              const gloss =
                (item as { gloss?: string }).gloss ?? extractGloss(item.text);
              const body = stripSummaryLine(item.text);
              return (
                <div
                  key={`reasoning-${nodeIdx}`}
                  className="flex items-stretch gap-2"
                >
                  <div className="flex flex-col items-center self-stretch">
                    <div className="flex min-h-7 min-w-7 shrink-0 items-center justify-center">
                      <div
                        className={cn(
                          "size-2 rounded-full",
                          hasErrors
                            ? "bg-destructive/60"
                            : "bg-muted-foreground/30",
                        )}
                      />
                    </div>
                    {!isLast && (
                      <div
                        className={cn(
                          "min-h-3 w-px flex-1",
                          hasErrors ? "bg-destructive/20" : "bg-border/40",
                        )}
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 pb-2 pl-2">
                    <p
                      title={body}
                      className={cn(
                        "truncate text-[11px] leading-relaxed font-semibold whitespace-nowrap",
                        hasErrors
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {gloss}
                    </p>
                    {body && body !== gloss && (
                      <p
                        className={cn(
                          "mt-0.5 text-[11px] leading-relaxed italic",
                          hasErrors
                            ? "text-destructive/70"
                            : "text-muted-foreground/60",
                        )}
                      >
                        {body}
                      </p>
                    )}
                  </div>
                </div>
              );
            }

            if (node.kind === "item") {
              return renderToolRow(
                (node.item as { entry: ToolCallEntry }).entry,
                `item-${nodeIdx}`,
                isLast,
              );
            }

            // Group of consecutive tool calls
            const groupKey = `group-${nodeIdx}`;
            const isGroupExpanded = expandedGroups.has(nodeIdx);
            const groupPending = node.entries.some(
              (c) =>
                c.state === "input-streaming" || c.state === "input-available",
            );
            const groupRunning = groupPending && !streamSettled;
            const groupInterrupted = groupPending && streamSettled;
            return (
              <div key={groupKey} className="flex items-stretch gap-2">
                <div className="flex flex-col items-center self-stretch">
                  <div className="flex min-h-7 min-w-7 shrink-0 items-center justify-center">
                    {groupRunning ? (
                      <Loader2 className="text-chart-4 size-4 animate-spin" />
                    ) : (
                      <ToolIcon
                        category={getToolCategory(node.entries[0]!.tool_name)}
                        size={20}
                        className="rounded-md"
                      />
                    )}
                  </div>
                  {!isLast && (
                    <div className="bg-border/40 min-h-3 w-px flex-1" />
                  )}
                </div>
                <div className="min-w-0 flex-1 pb-2">
                  <button
                    type="button"
                    onClick={() => toggleGroupExpansion(nodeIdx)}
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors"
                  >
                    <span className="text-[12px] font-medium">
                      {node.entries.length} tool calls
                    </span>
                    {groupRunning ? (
                      <span className="text-muted-foreground/60 text-[11px]">
                        running…
                      </span>
                    ) : groupInterrupted ? (
                      <span className="text-muted-foreground/60 text-[11px]">
                        interrupted
                      </span>
                    ) : null}
                    {isGroupExpanded ? (
                      <ChevronDown className="text-muted-foreground/50 size-3 transition-transform duration-150" />
                    ) : (
                      <ChevronRight className="text-muted-foreground/50 size-3 transition-transform duration-150" />
                    )}
                  </button>
                  {isGroupExpanded && (
                    <div className="mt-1">
                      {node.entries.map((call, i) =>
                        renderToolRow(
                          call,
                          `${groupKey}-${i}`,
                          i === node.entries.length - 1,
                        ),
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default ToolCallsSection;
