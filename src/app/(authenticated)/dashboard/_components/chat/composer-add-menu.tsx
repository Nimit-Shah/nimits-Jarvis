"use client";

import { useState } from "react";
import {
  Plus,
  Paperclip,
  FileText,
  Check,
  Settings2,
  ChevronRight,
  ChevronLeft,
  Loader2,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { trpc } from "~/clients/trpc";
import { useInstanceId } from "~/hooks/use-instance-id";

interface ComposerAddMenuProps {
  pinned: string[];
  onToggle: (slug: string) => void;
}

const SUBMENU_CAP = 10;

/**
 * Composer "+" menu (§6.1). Exactly two items — not a copy of any reference
 * screenshot: Add files (placeholder, disabled until upload lands) and Skills.
 * Skills opens an inline sub-panel (no DropdownMenu dep — Popover matches the
 * existing left-slot control). Pins are per-message and clear on send.
 */
export function ComposerAddMenu({ pinned, onToggle }: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"main" | "skills">("main");
  const [instanceId] = useInstanceId();

  const skillsQuery = trpc.nimitsJarvis.listSkills.useQuery(
    { instanceId: instanceId ?? undefined },
    { enabled: open && view === "skills" },
  );

  const close = () => {
    setOpen(false);
    setView("main");
  };

  const items = skillsQuery.data?.items ?? [];
  const shown = items.slice(0, SUBMENU_CAP);
  const overflow = items.length - shown.length;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView("main");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full text-muted-foreground hover:bg-white/10 hover:text-foreground"
          aria-label="Add to message"
        >
          <Plus className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1.5" align="start">
        {view === "main" ? (
          <>
            {/* Placeholder — slot reserved so the menu keeps its shape later */}
            <button
              disabled
              title="Coming soon"
              className="flex w-full cursor-not-allowed items-center gap-2.5 rounded-md px-2 py-2 text-left opacity-50"
            >
              <Paperclip className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-[13px] font-medium">
                Add files or photos
              </span>
              <kbd className="rounded border px-1 text-[10px] text-muted-foreground">
                ⌘U
              </kbd>
            </button>
            <button
              onClick={() => setView("skills")}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-[13px] font-medium">Skills</span>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setView("main")}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft className="size-3.5" />
              Back
            </button>
            {skillsQuery.isLoading && (
              <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading skills…
              </div>
            )}
            {skillsQuery.data && shown.length === 0 && (
              <div className="px-2 py-3 text-[12px] text-muted-foreground">
                No skills yet. Create one in Settings → Skills.
              </div>
            )}
            {shown.map((s) => {
              const isPinned = pinned.includes(s.slug);
              const pinOnly = s.trustTier !== "trusted";
              return (
                <button
                  key={s.slug}
                  onClick={() => onToggle(s.slug)}
                  title={
                    pinOnly
                      ? "Pin to use; this skill is not auto-selected"
                      : s.description
                  }
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent",
                    isPinned && "bg-accent/60",
                  )}
                >
                  <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">
                      {s.slug}
                      {pinOnly && (
                        <span className="ml-1.5 rounded border px-1 text-[10px] font-normal text-muted-foreground">
                          pin
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {s.description}
                    </span>
                  </span>
                  {isPinned && <Check className="mt-1 size-3.5 shrink-0 opacity-70" />}
                </button>
              );
            })}
            {overflow > 0 && (
              <div className="px-2 py-1 text-[11px] text-muted-foreground">
                +{overflow} more in Manage skills
              </div>
            )}
            <div className="mt-1 space-y-0.5 border-t pt-1">
              <a
                href="/dashboard/settings#skills"
                onClick={close}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-[13px] transition-colors hover:bg-accent"
              >
                <Settings2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium">Manage skills</span>
              </a>
              <a
                href="/dashboard/settings#skills-discover"
                onClick={close}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-[13px] transition-colors hover:bg-accent"
              >
                <Settings2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium">Browse skills</span>
              </a>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
