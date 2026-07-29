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
  state?: "input-streaming" | "input-available" | "output-available" | "output-error";
}

export interface ToolCallsSectionProps {
  toolCalls: ToolCallEntry[];
  reasoningTexts?: string[];
  maxIconsToShow?: number;
  defaultExpanded?: boolean;
  className?: string;
  iconSize?: number;
}

// ============================================================================
// Main Component
// ============================================================================

export function ToolCallsSection({
  toolCalls,
  reasoningTexts = [],
  maxIconsToShow = 10,
  defaultExpanded = false,
  className,
  iconSize = 20,
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

  return (
    <div className={cn("w-fit max-w-[40rem]", className)}>
      {/* Collapsible Header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 py-2 text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
      >
        {/* Stacked icons */}
        <div className="flex min-h-7 items-center -space-x-1.5">
          {displayIcons.map((call, i) => {
            const cat = getToolCategory(call.tool_name);
            return (
              <div
                key={`${call.tool_name}-${i}`}
                className="relative flex size-6 min-w-6 items-center justify-center"
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

        {/* Status label */}
        {isRunning ? (
          <Loader2 className="size-3 animate-spin text-chart-4" />
        ) : hasErrors ? (
          <XCircle className="size-3 text-destructive" />
        ) : null}

        <span className="text-[12px] font-medium">
          {isRunning
            ? runningCount === 1
              ? "Using a tool..."
              : `Using ${runningCount} tools...`
            : toolCalls.length === 1
              ? "Used 1 tool"
              : `Used ${toolCalls.length} tools`}
        </span>

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
          {toolCalls.map((call, index) => {
            const cat = getToolCategory(call.tool_name);
            const displayName = formatToolName(call.tool_name);
            const hasDetails = call.inputs || call.output;
            const isCallExpanded = expandedCalls.has(index);
            const isCallRunning =
              call.state === "input-streaming" || call.state === "input-available";
            const isCallError = call.state === "output-error";

            return (
              <div key={`${call.tool_name}-step-${index}`} className="flex items-stretch gap-2">
                {/* Icon column with connector */}
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

                {/* Content column */}
                <div className="flex-1 min-w-0 pb-2">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className={cn(
                        "flex items-center gap-1 group/tool",
                        hasDetails && "cursor-pointer",
                      )}
                      onClick={() => hasDetails && toggleCallExpansion(index)}
                    >
                      <span className="text-[12px] text-muted-foreground font-medium group-hover/tool:text-foreground transition-colors">
                        {call.message || displayName}
                      </span>
                      {hasDetails && (
                        <ChevronDown
                          className={cn(
                            "size-3 text-muted-foreground/50 transition-transform duration-150",
                            isCallExpanded && "rotate-180",
                          )}
                        />
                      )}
                    </button>

                    {/* Copy button */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCopy(call, index);
                      }}
                      className="opacity-0 group-hover/tool:opacity-100 transition-opacity text-muted-foreground/40 hover:text-muted-foreground"
                    >
                      {copiedIndex === index ? (
                        <Check className="size-3 text-chart-2" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </button>
                  </div>

                  {/* Expanded details */}
                  {isCallExpanded && hasDetails && (
                    <div className="mt-1.5 rounded-lg border border-border/30 bg-muted/20 p-2.5 max-h-48 overflow-y-auto">
                      {call.inputs && Object.keys(call.inputs).length > 0 && (
                        <div className="relative">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-medium text-chart-4">Input</span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void navigator.clipboard.writeText(
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
                      {call.output && (
                        <div className={cn(call.inputs && "mt-2 border-t border-border/30 pt-2")}>
                          <span className="text-[10px] font-medium text-chart-2">Output</span>
                          <CompactMarkdown content={call.output} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Reasoning text — rendered after all tools */}
          {reasoningTexts.length > 0 && (
            <div className="pl-7 pt-1 pb-1">
              <p className="text-[11px] text-muted-foreground/50 leading-relaxed">
                {reasoningTexts.filter(Boolean).join("\n")}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ToolCallsSection;
