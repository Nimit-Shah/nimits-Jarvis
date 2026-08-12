"use client";

import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";

interface MessageTimestampProps {
  /** ISO-8601 timestamp of the message. */
  createdAt: string;
  /** IANA timezone for the local date/time display. */
  timezone: string;
  className?: string;
}

const REFRESH_MS = 30_000;
const FULL_DATE_THRESHOLD_MS = 5 * 60 * 1000;

function formatRelative(fromIso: string, now: number): string {
  const diffMs = now - Date.parse(fromIso);
  if (Number.isNaN(diffMs)) return "";
  const seconds = Math.round(diffMs / 1000);

  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.round(days / 7);
  return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
}

function formatFullDateTime(fromIso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(fromIso));
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(fromIso));
  }
}

/**
 * Hover timestamp shown beside the copy button on user + assistant messages.
 *
 * Within the first 5 minutes it shows a live-updating relative time
 * ("4 minutes ago"). Once the message crosses 5 minutes old it switches to the
 * full local date & time (e.g. "Aug 11, 2026, 4:12 PM").
 */
export function MessageTimestamp({
  createdAt,
  timezone,
  className,
}: MessageTimestampProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  const ageMs = now - Date.parse(createdAt);
  const isRecent =
    !Number.isNaN(ageMs) && ageMs < FULL_DATE_THRESHOLD_MS && ageMs >= 0;

  const label = isRecent
    ? formatRelative(createdAt, now)
    : formatFullDateTime(createdAt, timezone);

  if (!label) return null;

  return (
    <span
      className={cn(
        "text-muted-foreground/50 pointer-events-none text-[10px] tabular-nums transition-opacity",
        className,
      )}
    >
      {label}
    </span>
  );
}
