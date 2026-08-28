"use client";

import { useState, useRef, useEffect } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import type { UIMessage } from "@ai-sdk/react";
import type {
  ChatStatus,
  DynamicToolUIPart,
  ToolUIPart,
  ReasoningUIPart,
} from "ai";
import { isToolUIPart, isReasoningUIPart, getToolName } from "ai";
import { ThinkingIndicator } from "./thinking-indicator";
import { ToolCallsSection } from "~/components/ui/tool-calls-section";
import type { ToolCallEntry } from "~/components/ui/tool-calls-section";
import { CodeBlock } from "./code-block";
import { TableBlock } from "./table-block";
import { stripToolResultEchoes } from "~/server/api/routers/nimits-jarvis/agent/strip-tool-echoes";
import { PROSE_CLASSES } from "./prose-classes";
import { MessageTimestamp } from "../message-timestamp";
import { useChatContext } from "../../chat-context";
import { formatToolName } from "~/components/ui/tool-calls-section-utils/tool-icons";

type TextUIPart = { type: "text"; text: string };

function mapToToolCallEntry(
  part: DynamicToolUIPart | ToolUIPart,
): ToolCallEntry {
  const rawName = getToolName(part);
  const persistedDisplayName = (part as unknown as { display_name?: string }).display_name;
  const displayName = persistedDisplayName ?? formatToolName(rawName);
  const category = rawName.replace(/^(COMPOSIO_|RUBE_)/, "").split("_")[0]?.toLowerCase() ?? "general";

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
    display_name: displayName,
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
    integration_name: displayName,
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

export function AssistantMessage({ message, status }: AssistantMessageProps) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const { timezone } = useChatContext();
  const createdAt = (message.metadata as { createdAt?: string } | undefined)
    ?.createdAt;

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const segments = segmentParts(message.parts);

  // Extract tool calls and reasoning in order
  const toolCalls = segments
    .filter(
      (s): s is Extract<MessageSegment, { kind: "tool-call" }> =>
        s.kind === "tool-call",
    )
    .map((s) => s.part);

  const reasoningSegments = segments.filter(
    (s): s is Extract<MessageSegment, { kind: "reasoning" }> =>
      s.kind === "reasoning",
  );

  const textSegments = segments.filter(
    (s): s is Extract<MessageSegment, { kind: "text" }> => s.kind === "text",
  );

  const isRunning = status === "streaming" || status === "submitted";

  // Build ordered chain of reasoning + tool calls for hierarchy display
  const reasoningTexts = reasoningSegments.map((s) => s.part.text);

  // Create interleaved items for proper ordering
  type ChainItem =
    | { type: "reasoning"; text: string; gloss?: string }
    | { type: "tool-call"; entry: ToolCallEntry };

  const chainItems: ChainItem[] = segments
    .filter(
      (
        s,
      ): s is
        | Extract<MessageSegment, { kind: "reasoning" }>
        | Extract<MessageSegment, { kind: "tool-call" }> =>
        s.kind === "reasoning" || s.kind === "tool-call",
    )
    .map((s) => {
      if (s.kind === "reasoning") {
        const gloss = (s.part as unknown as { gloss?: string }).gloss;
        return { type: "reasoning" as const, text: s.part.text, gloss };
      }
      return { type: "tool-call" as const, entry: mapToToolCallEntry(s.part) };
    });

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
    <div className="group space-y-4">
      {/* Chain of thought: reasoning + tool calls — above text */}
      {(reasoningTexts.length > 0 || toolCalls.length > 0) && (
        <ToolCallsSection
          toolCalls={toolCalls.map(mapToToolCallEntry)}
          reasoningTexts={reasoningTexts}
          chainItems={chainItems}
          isStreaming={isRunning}
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
        <div className="flex items-center gap-2">
          {createdAt && (
            <MessageTimestamp
              createdAt={createdAt}
              timezone={timezone}
              className="opacity-0 group-hover:opacity-100"
            />
          )}
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
        </div>
      )}
    </div>
  );
}
