"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Copy, Check } from "lucide-react";

interface CodeBlockProps {
  children?: React.ReactNode;
  className?: string;
}

function extractLanguage(className?: string): string {
  if (!className) return "";
  const match = className.match(/language-(\w+)/);
  return match?.[1] ?? "";
}

function extractTextContent(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (!children) return "";

  // Handle <code> inside <pre>
  if (
    typeof children === "object" &&
    "props" in children &&
    children.props
  ) {
    const props = children.props as Record<string, unknown>;
    if (typeof props.children === "string") return props.children;
    if (typeof props.children === "object" && props.children && "props" in (props.children as object)) {
      const inner = (props.children as Record<string, unknown>).props as Record<string, unknown>;
      if (typeof inner.children === "string") return inner.children;
    }
  }

  return "";
}

export function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  const language = extractLanguage(className);
  const code = extractTextContent(children);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="group/code relative my-3 overflow-hidden rounded-lg border border-border/50 bg-[var(--prose-code-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/30 px-3 py-1.5">
        <span className="text-[10px] font-medium text-muted-foreground/60">
          {language || "code"}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground/40 transition-colors hover:bg-muted/50 hover:text-muted-foreground"
        >
          {copied ? (
            <>
              <Check className="size-3" />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-3" />
              Copy
            </>
          )}
        </button>
      </div>
      {/* Body */}
      <div className="overflow-x-auto p-3">
        <pre
          className="text-[12px] leading-relaxed text-foreground/80 whitespace-pre-wrap break-words font-mono"
          {...props}
        >
          {code}
        </pre>
      </div>
    </div>
  );
}