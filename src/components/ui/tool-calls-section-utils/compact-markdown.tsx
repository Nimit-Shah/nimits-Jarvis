"use client";

import { useMemo } from "react";

interface CompactMarkdownProps {
  content: unknown;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

export function CompactMarkdown({ content }: CompactMarkdownProps) {
  const formatted = useMemo(() => formatValue(content), [content]);

  return (
    <pre className="whitespace-pre-wrap break-all text-[11px] leading-relaxed text-muted-foreground/70 font-mono">
      {formatted}
    </pre>
  );
}
