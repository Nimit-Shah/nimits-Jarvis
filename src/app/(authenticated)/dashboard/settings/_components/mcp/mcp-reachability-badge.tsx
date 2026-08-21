"use client";

import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";

export function McpReachabilityBadge({ reachability }: { reachability: string }) {
  const label = reachability === "loopback" ? "Local" : reachability === "private" ? "Network" : "Remote";
  const tooltip =
    reachability === "loopback"
      ? "Only available when Jarvis runs on this machine."
      : reachability === "private"
        ? "Only available on your local network."
        : undefined;

  const badge = (
    <Badge variant={reachability === "remote" ? "secondary" : "outline"} className="text-[10px]">
      {label}
    </Badge>
  );

  if (!tooltip) return badge;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent><p className="text-xs">{tooltip}</p></TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
