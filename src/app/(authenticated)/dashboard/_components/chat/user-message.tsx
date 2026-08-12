"use client";

import { useState, useRef, useEffect } from "react";
import { Copy, Check } from "lucide-react";
import type { UIMessage } from "@ai-sdk/react";
import { MessageTimestamp } from "./message-timestamp";
import { useChatContext } from "../chat-context";

interface UserMessageProps {
  message: UIMessage;
}

export function UserMessage({ message }: UserMessageProps) {
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

  const textContent = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");

  const handleCopy = () => {
    void navigator.clipboard.writeText(textContent);
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };

  const paragraphs = textContent.split(/\n\n+/).filter(Boolean);

  return (
    <div className="group flex flex-col items-end">
      <div className="relative max-w-[80%]">
        <div className="bg-muted text-foreground space-y-1 rounded-2xl px-3 py-2 text-[12px]">
          {paragraphs.map((p, i) => (
            <p key={i} className="leading-relaxed whitespace-pre-wrap">
              {p}
            </p>
          ))}
        </div>
      </div>

      <div className="mt-1 mr-1 flex items-center gap-2">
        {createdAt && (
          <MessageTimestamp
            createdAt={createdAt}
            timezone={timezone}
            className="opacity-0 group-hover:opacity-100"
          />
        )}
        <button
          onClick={handleCopy}
          className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        >
          {copied ? (
            <Check className="size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
