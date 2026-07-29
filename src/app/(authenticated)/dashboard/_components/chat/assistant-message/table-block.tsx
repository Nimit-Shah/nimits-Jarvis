"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Copy, Check } from "lucide-react";

function tableToText(tableEl: HTMLTableElement): string {
  const rows: string[][] = [];
  for (const row of Array.from(tableEl.rows)) {
    const cells = Array.from(row.cells).map((c) => c.textContent?.trim() ?? "");
    rows.push(cells);
  }
  return rows.map((r) => r.join("\t")).join("\n");
}

interface TableBlockProps {
  children?: React.ReactNode;
}

export function TableBlock({ children, ...props }: TableBlockProps) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    if (!tableRef.current) return;
    void navigator.clipboard.writeText(tableToText(tableRef.current));
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <div className="group/table relative my-3 overflow-hidden rounded-lg border border-border/50">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/30 bg-muted/30 px-3 py-1.5">
        <span className="text-[10px] font-medium text-muted-foreground/50">
          table
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground/40 transition-colors hover:bg-muted hover:text-muted-foreground"
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
      {/* Table */}
      <div className="overflow-x-auto">
        <table
          ref={tableRef}
          className="w-full text-[12px] [&_th]:border-b [&_th]:border-border/60 [&_th]:bg-muted/20 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:border-b [&_td]:border-border/40 [&_td]:px-3 [&_td]:py-1.5 [&_td]:text-foreground/80 [&_tr:last-child_td]:border-0"
          {...props}
        >
          {children}
        </table>
      </div>
    </div>
  );
}