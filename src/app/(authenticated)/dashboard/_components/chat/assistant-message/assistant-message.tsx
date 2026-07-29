"use client";

import { useState, useRef, useEffect } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import type { UIMessage } from "@ai-sdk/react";
import type { ChatStatus, DynamicToolUIPart, ToolUIPart, ReasoningUIPart } from "ai";
import { isToolUIPart, isReasoningUIPart, getToolName } from "ai";
import { ThinkingIndicator } from "./thinking-indicator";
import { ToolCallsSection } from "~/components/ui/tool-calls-section";
import type { ToolCallEntry } from "~/components/ui/tool-calls-section";
import { CodeBlock } from "./code-block";
import { TableBlock } from "./table-block";
import { stripToolResultEchoes } from "~/server/api/routers/nimits-jarvis/agent/strip-tool-echoes";
import { PROSE_CLASSES } from "./prose-classes";

type TextUIPart = { type: "text"; text: string };

function mapToToolCallEntry(part: DynamicToolUIPart | ToolUIPart): ToolCallEntry {
  const rawName = getToolName(part);
  const displayName = rawName.replace(/^(COMPOSIO_|RUBE_)/, "");
  const category = displayName.split("_")[0]?.toLowerCase() ?? "general";

  let state: ToolCallEntry["state"];
  if (part.state === "input-streaming" || part.state === "input-available") {
    state = part.state;
  } else if (part.state === "output-available") {
    state = "output-available";
  } else if (part.state === "output-error") {
    state = "output-error";
  }

  return {
    tool_name: rawName,
    tool_category: category,
    message:
      state === "input-streaming" || state === "input-available"
        ? `Using ${displayName}...`
        : `Used ${displayName}`,
    inputs: part.input as Record<string, unknown>,
    output:
      part.state === "output-available"
        ? typeof part.output === "string"
          ? part.output
          : JSON.stringify(part.output, null, 2)
        : undefined,
    integration_name: displayName.replace(/_/g, " "),
    state,
  };
}

type MessageSegment =
  | { kind: "text"; parts: TextUIPart[] }
  | { kind: "tool-call"; part: DynamicToolUIPart | ToolUIPart }
  | { kind: "reasoning"; part: ReasoningUIPart };

function segmentParts(parts: UIMessage["parts"]): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let textAccum: TextUIPart[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      textAccum.push(part);
    } else if (isToolUIPart(part)) {
      if (textAccum.length > 0) {
        segments.push({ kind: "text", parts: textAccum });
        textAccum = [];
      }
      segments.push({ kind: "tool-call", part });
    } else if (isReasoningUIPart(part)) {
      if (textAccum.length > 0) {
        segments.push({ kind: "text", parts: textAccum });
        textAccum = [];
      }
      segments.push({ kind: "reasoning", part });
    }
  }
  if (textAccum.length > 0) {
    segments.push({ kind: "text", parts: textAccum });
  }
  return segments;
}

interface AssistantMessageProps {
  message: UIMessage;
  status: ChatStatus;
}

export function AssistantMessage({
  message,
  status,
}: AssistantMessageProps) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const segments = segmentParts(message.parts);

  const toolCalls = segments
    .filter((s): s is Extract<MessageSegment, { kind: "tool-call" }> => s.kind === "tool-call")
    .map((s) => s.part);

  const reasoningSegments = segments.filter(
    (s): s is Extract<MessageSegment, { kind: "reasoning" }> => s.kind === "reasoning",
  );

  const textSegments = segments.filter(
    (s): s is Extract<MessageSegment, { kind: "text" }> => s.kind === "text",
  );

  const isRunning = status === "streaming" || status === "submitted";

  const reasoningTexts = reasoningSegments.map((s) => s.part.text);

  const getFullTextContent = () =>
    textSegments
      .map((s) => stripToolResultEchoes(s.parts.map((p) => p.text).join("")))
      .filter(Boolean)
      .join("\n");

  const hasTextContent = textSegments.length > 0;

  const handleCopy = () => {
    void navigator.clipboard.writeText(getFullTextContent());
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };

  if (segments.length === 0) {
    if (status === "error") {
      return (
        <div className="text-destructive flex items-center gap-2 py-2 text-[12px]">
          <span>Something went wrong</span>
        </div>
      );
    }

    if (isRunning) {
      return <ThinkingIndicator />;
    }

    return null;
  }

  return (
    <div className="space-y-4">
      {/* Chain of thought: reasoning + tool calls — above text */}
      {(reasoningTexts.length > 0 || toolCalls.length > 0) && (
        <ToolCallsSection
          toolCalls={toolCalls.map(mapToToolCallEntry)}
          reasoningTexts={reasoningTexts}
        />
      )}

      {/* Text content — always visible */}
      {textSegments.map((segment, idx) => {
        const textContent = stripToolResultEchoes(
          segment.parts.map((p) => p.text).join(""),
        );
        if (!textContent) return null;

        return (
          <div key={`text-${idx}`} className={`min-w-0 ${PROSE_CLASSES}`}>
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                pre: ({ children, ...props }) => (
                  <CodeBlock {...props}>{children}</CodeBlock>
                ),
                table: ({ children, ...props }) => (
                  <TableBlock {...props}>{children}</TableBlock>
                ),
              }}
            >
              {textContent}
            </Markdown>
          </div>
        );
      })}

      {/* Copy button */}
      {hasTextContent && (
        <button
          onClick={handleCopy}
          className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
        >
          {copied ? (
            <Check className="size-3" />
          ) : (
            <Copy className="size-3" />
          )}
        </button>
      )}
    </div>
  );
}