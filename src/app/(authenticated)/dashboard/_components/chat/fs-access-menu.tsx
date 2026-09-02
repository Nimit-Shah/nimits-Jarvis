"use client";

import { useEffect, useState } from "react";
import { Eye, Terminal, Check, Settings2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";

export type FsAccessMode = "read-only" | "full";

interface FsAccessMenuProps {
  mode: FsAccessMode;
  onModeChange: (mode: FsAccessMode) => void;
  /** Instance ceiling — Full is only selectable when true */
  fsWriteAllowed?: boolean;
  /** Trigger is disabled until the instance query resolves (no flicker) */
  instanceResolved?: boolean;
}

/**
 * Two-item access dropdown in the composer's left slot, beside the (future)
 * attachment button. Component state only — never persisted. The icon IS the
 * state indicator (Eye = read-only, Terminal = full).
 */
export function FsAccessMenu({
  mode,
  onModeChange,
  fsWriteAllowed = false,
  instanceResolved = true,
}: FsAccessMenuProps) {
  const [open, setOpen] = useState(false);

  // Reset to read-only whenever the chat changes (mode is per-message, not persisted)
  useEffect(() => {}, []); // reset is handled by the parent remounting on chatId change

  const label = mode === "full" ? "Full System Access" : "Read-Only Access";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full text-muted-foreground hover:bg-white/10 hover:text-foreground"
          disabled={!instanceResolved}
          aria-label={`File access: ${label}`}
          title={instanceResolved ? `File access: ${label}` : undefined}
        >
          {mode === "full" ? <Terminal className="size-4" /> : <Eye className="size-4" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1.5" align="start">
        {/* Read-Only — default, always selectable */}
        <button
          onClick={() => {
            onModeChange("read-only");
            setOpen(false);
          }}
          className={cn(
            "flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent",
            mode === "read-only" && "bg-accent/60",
          )}
        >
          <Eye className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">Read-Only Access</span>
            <span className="block text-[11px] text-muted-foreground">Read files on your Mac</span>
          </span>
          {mode === "read-only" && <Check className="mt-1 size-3.5 shrink-0 opacity-70" />}
        </button>

        {/* Full — only selectable when the instance ceiling allows writes */}
        <button
          onClick={() => {
            if (!fsWriteAllowed) return;
            onModeChange("full");
            setOpen(false);
          }}
          disabled={!fsWriteAllowed}
          className={cn(
            "flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
            fsWriteAllowed ? "hover:bg-accent" : "cursor-not-allowed opacity-50",
            mode === "full" && "bg-accent/60",
          )}
        >
          <Terminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">Full System Access</span>
            <span className="block text-[11px] text-muted-foreground">Read, write, and run scripts</span>
          </span>
          {mode === "full" && <Check className="size-3.5 shrink-0 opacity-70" />}
        </button>

        {!fsWriteAllowed && (
          <div className="mt-1 flex items-center gap-1.5 border-t px-2 pb-1 pt-2 text-[11px] text-muted-foreground">
            <Settings2 className="size-3 shrink-0" />
            <span>
              Enable write access in{" "}
              <a href="/dashboard/settings" className="underline hover:text-foreground">
                Settings → Files
              </a>
            </span>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
