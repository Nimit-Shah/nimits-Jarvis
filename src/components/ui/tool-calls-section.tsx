"use client";

import { useMemo, useState, useCallback } from "react";
import { ChevronDown, Copy, Check, Loader2, XCircle } from "lucide-react";
import { cn } from "~/lib/utils";
import {
  formatToolName,
  getToolCategory,
} from "./tool-calls-section-utils/tool-icons";
import { CompactMarkdown } from "./tool-calls-section-utils/compact-markdown";
import { ToolIcon } from "./tool-calls-section-utils/icons";
import { extractGloss, stripSummaryLine } from "./tool-calls-section-utils/reasoning-gloss";
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
  state?: "input-streaming" | "input-available" | "output-available" | "output-error";
}

export interface ToolCallsSectionProps {
  toolCalls: ToolCallEntry[];
  reasoningTexts?: string[];
  chainItems?: Array<{ type: "reasoning"; text: string; gloss?: string } | { type: "tool-call"; entry: ToolCallEntry }>;
  maxIconsToShow?: number;
  defaultExpanded?: boolean;
  className?: string;
  iconSize?: number;
  isStreaming?: boolean;
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
  const [expandedCalls, setExpandedCalls] = useState<Set<number>>(new Set());
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const toggleCallExpansion = useCallback((index: number) => {
    setExpandedCalls((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

const handleCopy = useCallback((call: ToolCallEntry, index: number) => {
  const data = {
    tool: call.tool_name,
    inputs: call.inputs,
    output: call.output,
  };
  void navigator.clipboard.writeText(JSON.stringify(data, null, 2));
  setCopiedIndex(index);
  setTimeout(() => setCopiedIndex(null), 2000);
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

  if (toolCalls.length === 0 && reasoningTexts.length === 0) return null;

  const hasErrors = toolCalls.some((c) => c.state === "output-error");
  const runningCount = toolCalls.filter(
    (c) => c.state === "input-streaming" || c.state === "input-available",
  ).length;
  const isRunning = runningCount > 0;

  // --- Collapsed state machine (Claude.ai-inspired) ---
  const runningTools = useMemo(
    () => toolCalls.filter((c) => c.state === "input-streaming" || c.state === "input-available"),
    [toolCalls],
  );

  const lastReasoningGloss = useMemo(() => {
    if (chainItems && chainItems.length > 0) {
      for (let i = chainItems.length - 1; i >= 0; i--) {
        const item = chainItems[i]!;
        if (item.type === "reasoning") return extractGloss((item as { gloss?: string; text: string }).gloss ?? item.text);
      }
    }
    if (reasoningTexts.length > 0) return extractGloss(reasoningTexts[reasoningTexts.length - 1]!);
    return null;
  }, [chainItems, reasoningTexts]);

  const mostRecentGloss = useMemo(() => {
    if (!chainItems || chainItems.length === 0) return null;
    const last = chainItems[chainItems.length - 1]!;
    if (last.type === "reasoning") return extractGloss((last as { gloss?: string; text: string }).gloss ?? last.text);
    return null;
  }, [chainItems]);

  const aggregatedSummary = useMemo(() => {
    if (toolCalls.length === 0) return "";
    const seen = new Set<string>();
    const names: string[] = [];
    for (const c of toolCalls) {
      const display = c.display_name || formatToolName(c.tool_name);
      const key = display.toLowerCase();
      if (!seen.has(key)) { seen.add(key); names.push(display); }
    }
    if (names.length === 0) return `Used ${toolCalls.length} tool${toolCalls.length > 1 ? "s" : ""}`;
    // Dynamic fit to one line: try 5, fall back to 4, 3, 2 to avoid wrapping on long names
    const build = (n: number) =>
      names.length <= n ? `Used ${names.join(", ")}` : `Used ${names.slice(0, n).join(", ")} and more`;
    for (let n = 5; n >= 2; n--) {
      if (build(n).length <= 58) return build(n);
    }
    return `Used ${names[0]} and more`;
  }, [toolCalls]);

  const { collapsedLabel, showLoader } = useMemo(() => {
    // Reasoning-only turn (no tools): always show gloss
    if (toolCalls.length === 0) {
      return { collapsedLabel: lastReasoningGloss ?? "Thinking", showLoader: false };
    }
    if (isRunning) {
      // Most recent item is reasoning → show its gloss (State 0, interleaved)
      if (mostRecentGloss) return { collapsedLabel: mostRecentGloss, showLoader: false };
      if (runningTools.length > 0) {
        // State 1: single tool initiated → machine name, with loader
        if (runningTools.length === 1) {
          const raw = runningTools[0]!.tool_name;
          return { collapsedLabel: `Used ${raw}`, showLoader: true };
        }
        // State 2: multiple concurrent → count
        return { collapsedLabel: `Used ${runningTools.length} tools`, showLoader: true };
      }
      // Fallback between tools: show last gloss if any
      if (lastReasoningGloss) return { collapsedLabel: lastReasoningGloss, showLoader: false };
      return { collapsedLabel: `Used ${toolCalls.length} tools`, showLoader: true };
    }
    // State 3 — turn complete: always end on tools aggregate (not gloss)
    if (hasErrors) {
      // Show failed tool machine name if single failure, else aggregate with — failed
      const failed = toolCalls.filter((c) => c.state === "output-error");
      if (failed.length === 1) return { collapsedLabel: `Used ${failed[0]!.tool_name} — failed`, showLoader: false };
      return { collapsedLabel: `${aggregatedSummary} — failed`, showLoader: false };
    }
    return { collapsedLabel: aggregatedSummary || `Used ${toolCalls.length} tools`, showLoader: false };
  }, [toolCalls, runningTools, isRunning, lastReasoningGloss, mostRecentGloss, aggregatedSummary, hasErrors]);

  const isStreamingEffective = isStreaming ?? isRunning;
  const shouldShimmer = isStreamingEffective;

  return (
    <div className={cn("w-fit max-w-[40rem]", className)}>
      {/* Collapsible Header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex min-w-0 items-center gap-2 py-2 text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
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
                    isFailedIcon && "ring-1 ring-destructive/50 bg-destructive/10",
                  )}
                  style={{
                    rotate: displayIcons.length > 1 ? (i % 2 === 0 ? "6deg" : "-6deg") : "0deg",
                    zIndex: i,
                  }}
                >
                  <ToolIcon category={cat} size={20} className="rounded-md" />
                </div>
              );
            })}
            {extraCount > 0 && (
              <div className="z-0 flex size-5 min-h-5 min-w-5 items-center justify-center rounded-md bg-muted text-[10px] text-muted-foreground">
                +{extraCount}
              </div>
            )}
          </div>
        )}

        {/* Status loader / error */}
        {showLoader ? (
          <Loader2 className="size-3 animate-spin text-chart-4" />
        ) : hasErrors ? (
          <XCircle className="size-3 text-destructive" />
        ) : null}

        {shouldShimmer ? (
          <TextShimmer
            as="span"
            duration={1}
            spread={2}
            className="truncate whitespace-nowrap text-[12px] font-medium"
          >
            {collapsedLabel}
          </TextShimmer>
        ) : (
          <span className={cn("truncate whitespace-nowrap text-[12px] font-medium", hasErrors && "text-destructive")}>
            {collapsedLabel}
          </span>
        )}

        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground transition-transform duration-200",
            isExpanded && "rotate-180",
          )}
        />
      </button>

      {/* Expandable Content */}
      <div
        className={cn(
          "overflow-hidden transition-all duration-200",
          isExpanded ? "max-h-[3000px] opacity-100" : "max-h-0 opacity-0",
        )}
      >
        <div className="space-y-0 pt-1">
          {chainItems && chainItems.length > 0 ? (
            // Interleaved rendering: reasoning and tool calls in order
            chainItems.map((item, index) => {
              if (item.type === "reasoning") {
                // Collapsed shows gloss (1 line); expanded shows gloss bold + full paragraph (reverted to restore 2-line context)
                const gloss = (item as { gloss?: string }).gloss ?? extractGloss(item.text);
                const body = stripSummaryLine(item.text);
                return (
                  <div key={`reasoning-${index}`} className="flex items-stretch gap-2">
                    <div className="flex flex-col items-center self-stretch">
                      <div className="flex min-h-7 min-w-7 items-center justify-center shrink-0">
                        <div className={cn("size-2 rounded-full", hasErrors ? "bg-destructive/60" : "bg-muted-foreground/30")} />
                      </div>
                      {index < chainItems.length - 1 && (
                        <div className={cn("w-px flex-1 min-h-3", hasErrors ? "bg-destructive/20" : "bg-border/40")} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 pb-2 pl-2">
                      <p
                        title={body}
                        className={cn(
                          "truncate whitespace-nowrap text-[11px] font-semibold leading-relaxed",
                          hasErrors ? "text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {gloss}
                      </p>
                      {body && body !== gloss && (
                        <p className={cn("mt-0.5 text-[11px] leading-relaxed italic", hasErrors ? "text-destructive/70" : "text-muted-foreground/60")}>
                          {body}
                        </p>
                      )}
                    </div>
                  </div>
                );
              }
              
              // Render tool call
              const call = item.entry;
              const cat = getToolCategory(call.tool_name);
              const displayName = formatToolName(call.tool_name);
              const hasDetails = call.inputs || call.output;
              const isCallExpanded = expandedCalls.has(index);
              const isCallRunning = call.state === "input-streaming" || call.state === "input-available";
              const isCallError = call.state === "output-error";

              return (
                <div key={`${call.tool_name}-step-${index}`} className="flex items-stretch gap-2">
                  <div className="flex flex-col items-center self-stretch">
                    <div className="flex min-h-7 min-w-7 items-center justify-center shrink-0">
                      {isCallRunning ? (
                        <Loader2 className="size-4 animate-spin text-chart-4" />
                      ) : isCallError ? (
                        <XCircle className="size-4 text-destructive" />
                      ) : (
                        <ToolIcon category={cat} size={20} className="rounded-md" />
                      )}
                    </div>
                    {index < chainItems.length - 1 && (
                      <div className="w-px flex-1 bg-border/40 min-h-3" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0 pb-2">
                    <div className={cn(
                      "flex items-center gap-1 rounded-md px-2 py-1",
                      isCallError && "border border-destructive/50 bg-destructive/5",
                    )}>
                      <button
                        type="button"
                        className={cn("flex items-center gap-1 group/tool", hasDetails && "cursor-pointer")}
                        onClick={() => hasDetails && toggleCallExpansion(index)}
                      >
                        <span className={cn(
                          "text-[12px] font-medium group-hover/tool:text-foreground transition-colors",
                          isCallError ? "text-destructive" : "text-muted-foreground",
                        )}>
                          {isCallError ? (call.message || `Failed: ${displayName}`) : (call.message || displayName)}
                        </span>
                        {hasDetails && (
                          <ChevronDown className={cn("size-3 text-muted-foreground/50 transition-transform duration-150", isCallExpanded && "rotate-180")} />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleCopy(call, index); }}
                        className="opacity-0 group-hover/tool:opacity-100 transition-opacity text-muted-foreground/40 hover:text-muted-foreground"
                      >
                        {copiedIndex === index ? <Check className="size-3 text-chart-2" /> : <Copy className="size-3" />}
                      </button>
                    </div>
                    {isCallExpanded && hasDetails && (
                      <div className={cn(
                        "mt-1.5 rounded-lg border p-2.5 max-h-48 overflow-y-auto",
                        isCallError ? "border-destructive/30 bg-destructive/5" : "border-border/30 bg-muted/20",
                      )}>
                        {call.inputs && Object.keys(call.inputs).length > 0 && (
                          <div className="relative">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-medium text-chart-4">Input</span>
                              <button type="button" onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText(JSON.stringify(call.inputs, null, 2)); }} className="text-muted-foreground/40 hover:text-muted-foreground transition-colors">
                                <Copy className="size-3" />
                              </button>
                            </div>
                            <CompactMarkdown content={call.inputs} />
                          </div>
                        )}
                        {call.output && (
                          <div className={cn(call.inputs && "mt-2 border-t pt-2", isCallError ? "border-destructive/30" : "border-border/30")}>
                            <span className={cn("text-[10px] font-medium", isCallError ? "text-destructive" : "text-chart-2")}>{isCallError ? "Error" : "Output"}</span>
                            <CompactMarkdown content={call.output} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            // Fallback: legacy rendering (tool calls only, then reasoning)
            <>
              {toolCalls.map((call, index) => {
                const cat = getToolCategory(call.tool_name);
                const displayName = formatToolName(call.tool_name);
                const hasDetails = call.inputs || call.output;
                const isCallExpanded = expandedCalls.has(index);
                const isCallRunning = call.state === "input-streaming" || call.state === "input-available";
                const isCallError = call.state === "output-error";

                return (
                  <div key={`${call.tool_name}-step-${index}`} className="flex items-stretch gap-2">
                    <div className="flex flex-col items-center self-stretch">
                      <div className="flex min-h-7 min-w-7 items-center justify-center shrink-0">
                        {isCallRunning ? (
                          <Loader2 className="size-4 animate-spin text-chart-4" />
                        ) : isCallError ? (
                          <XCircle className="size-4 text-destructive" />
                        ) : (
                          <ToolIcon category={cat} size={20} className="rounded-md" />
                        )}
                      </div>
                      {index < toolCalls.length - 1 && (
                        <div className="w-px flex-1 bg-border/40 min-h-3" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 pb-2">
                      <div className={cn(
                        "flex items-center gap-1 rounded-md px-2 py-1",
                        isCallError && "border border-destructive/50 bg-destructive/5",
                      )}>
                        <button type="button" className={cn("flex items-center gap-1 group/tool", hasDetails && "cursor-pointer")} onClick={() => hasDetails && toggleCallExpansion(index)}>
                          <span className={cn("text-[12px] font-medium group-hover/tool:text-foreground transition-colors", isCallError ? "text-destructive" : "text-muted-foreground")}>
                            {isCallError ? (call.message || `Failed: ${displayName}`) : (call.message || displayName)}
                          </span>
                          {hasDetails && <ChevronDown className={cn("size-3 text-muted-foreground/50 transition-transform duration-150", isCallExpanded && "rotate-180")} />}
                        </button>
                        <button type="button" onClick={(e) => { e.stopPropagation(); handleCopy(call, index); }} className="opacity-0 group-hover/tool:opacity-100 transition-opacity text-muted-foreground/40 hover:text-muted-foreground">
                          {copiedIndex === index ? <Check className="size-3 text-chart-2" /> : <Copy className="size-3" />}
                        </button>
                      </div>
                      {isCallExpanded && hasDetails && (
                        <div className={cn("mt-1.5 rounded-lg border p-2.5 max-h-48 overflow-y-auto", isCallError ? "border-destructive/30 bg-destructive/5" : "border-border/30 bg-muted/20")}>
                          {call.inputs && Object.keys(call.inputs).length > 0 && (
                            <div className="relative">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-medium text-chart-4">Input</span>
                                <button type="button" onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText(JSON.stringify(call.inputs, null, 2)); }} className="text-muted-foreground/40 hover:text-muted-foreground transition-colors">
                                  <Copy className="size-3" />
                                </button>
                              </div>
                              <CompactMarkdown content={call.inputs} />
                            </div>
                          )}
                          {call.output && (
                            <div className={cn(call.inputs && "mt-2 border-t pt-2", isCallError ? "border-destructive/30" : "border-border/30")}>
                              <span className={cn("text-[10px] font-medium", isCallError ? "text-destructive" : "text-chart-2")}>{isCallError ? "Error" : "Output"}</span>
                              <CompactMarkdown content={call.output} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {reasoningTexts.length > 0 && (
                <div className="pl-7 pt-1 pb-1">
                  <p className="text-[11px] text-muted-foreground/50 leading-relaxed">
                    {reasoningTexts.filter(Boolean).join("\n")}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ToolCallsSection;
