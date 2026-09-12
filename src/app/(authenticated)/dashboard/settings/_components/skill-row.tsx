"use client";

import { useState } from "react";
import { FileText, MoreVertical, Eye, PenLine, ShieldCheck, Power, Trash2, FolderOpen } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";

export interface SkillListItem {
  slug: string;
  displayName: string;
  description: string;
  trustTier: string;
  origin: string;
  enabled: boolean;
  sourceRepo?: string | null;
  discoverySource?: string | null;
  lastUsedAt?: string | Date | null;
  useCount: number;
  updatedAt: string | Date;
}

function trustBadge(tier: string) {
  if (tier === "trusted") return null;
  return (
    <span
      className={cn(
        "ml-1.5 rounded border px-1 text-[10px] font-normal",
        tier === "verified"
          ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
          : "border-red-500/40 text-red-600 dark:text-red-400",
      )}
    >
      {tier}
    </span>
  );
}

export function SkillRow({
  skill,
  onView,
  onEdit,
  onTrust,
  onToggleEnable,
  onDelete,
  busy,
}: {
  skill: SkillListItem;
  onView: () => void;
  onEdit: () => void;
  onTrust: () => void;
  onToggleEnable: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const when = skill.lastUsedAt ?? skill.updatedAt;
  let sourceHost: string | null = null;
  try {
    sourceHost = skill.sourceRepo ? new URL(skill.sourceRepo).hostname : null;
  } catch {
    sourceHost = null;
  }

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-md px-2 py-2",
        !skill.enabled && "opacity-50",
      )}
    >
      <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <button onClick={onView} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13px] font-medium">
          {skill.slug}
          {sourceHost && (
            <span className="ml-1.5 rounded border px-1 text-[10px] font-normal text-muted-foreground">
              {sourceHost}
            </span>
          )}
          {skill.discoverySource === "auto" && (
            <span
              title="Auto-discovered via find_skill"
              className="ml-1.5 rounded border px-1 text-[10px] font-normal text-muted-foreground"
            >
              auto
            </span>
          )}
          {trustBadge(skill.trustTier)}
          {!skill.enabled && (
            <span className="ml-1.5 rounded border px-1 text-[10px] font-normal text-muted-foreground">
              disabled
            </span>
          )}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {skill.description}
        </span>
      </button>
      <span className="shrink-0 pt-0.5 text-[11px] text-muted-foreground">
        {formatDistanceToNow(new Date(when), { addSuffix: true })}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
            aria-label={`Actions for ${skill.slug}`}
            disabled={busy}
          >
            <MoreVertical className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-52 p-1.5" align="end">
          <button
            onClick={act(onView)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
          >
            <Eye className="size-3.5 text-muted-foreground" /> View instructions
          </button>
          {skill.origin === "authored" && (
            <button
              onClick={act(onEdit)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
            >
              <PenLine className="size-3.5 text-muted-foreground" /> Edit
            </button>
          )}
          <button
            onClick={act(onTrust)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
          >
            <ShieldCheck className="size-3.5 text-muted-foreground" /> Set trust tier
          </button>
          <button
            onClick={act(onToggleEnable)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
          >
            <Power className="size-3.5 text-muted-foreground" />
            {skill.enabled ? "Disable" : "Enable"}
          </button>
          <button
            onClick={act(onDelete)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-destructive hover:bg-accent"
          >
            <Trash2 className="size-3.5" /> Delete
          </button>
          <div className="mt-1 flex items-center gap-1.5 border-t px-2 pb-1 pt-2 text-[11px] text-muted-foreground">
            <FolderOpen className="size-3 shrink-0" />
            <span className="truncate">Uses: {skill.useCount}×</span>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
