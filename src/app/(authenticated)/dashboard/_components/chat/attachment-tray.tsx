"use client";

import { X, TriangleAlert } from "lucide-react";
import { cn } from "~/lib/utils";
import type { TrayAttachment } from "./use-attachments";

function Tile({ item, onRemove, dimmed }: { item: TrayAttachment; onRemove: () => void; dimmed?: boolean }) {
  return (
    <div className="flex w-20 shrink-0 flex-col gap-1">
      <div className={cn("relative aspect-square w-20 overflow-hidden rounded-lg border border-border/60 bg-muted/40", dimmed && "opacity-50 saturate-50")}>
        {item.status === "ready" && (item.thumbUrl ?? item.previewUrl) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.thumbUrl ?? item.previewUrl}
            alt="Attached image"
            className="h-full w-full object-cover"
          />
        ) : item.status === "error" ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 border border-destructive/60 text-destructive">
            <TriangleAlert className="size-5" />
            <span className="max-w-full truncate px-1 text-[10px]" title={item.error}>
              {item.error ?? "Failed"}
            </span>
          </div>
        ) : item.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.previewUrl} alt="Uploading" className="h-full w-full object-cover opacity-60" />
        ) : (
          <div className="h-full w-full animate-pulse bg-gradient-to-r from-muted via-muted-foreground/20 to-muted" />
        )}
        {item.status !== "ready" && item.status !== "error" && (
          <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/20 to-transparent" />
        )}
        <button
          onClick={onRemove}
          aria-label="Remove attached image"
          className="absolute right-1 top-1 rounded-full bg-background/80 p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Horizontal tray above the composer input. Not rendered when empty. */
export function AttachmentTray({
  items,
  onRemove,
  dimmed,
}: {
  items: TrayAttachment[];
  onRemove: (tempId: string) => void;
  dimmed?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="px-1 pb-1">
      <div className="flex gap-2 overflow-x-auto">
        {items.map((item) => (
          <Tile key={item.tempId} item={item} dimmed={dimmed} onRemove={() => onRemove(item.tempId)} />
        ))}
      </div>
      <p className={cn("pt-1 text-[11px] text-muted-foreground/70")}>
        Images are sent to the provider as-is and are not redacted.
      </p>
    </div>
  );
}
