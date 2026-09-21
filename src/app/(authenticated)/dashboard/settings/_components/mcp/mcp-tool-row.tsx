"use client";

import { useState } from "react";
import { CalendarClock, ChevronRight } from "lucide-react";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import type { McpToolSummary } from "./mcp-server-type";

function scrollToCronJobs() {
  document.getElementById("cron-jobs")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function McpToolRow({
  tool,
  serverEnabled,
  shorten,
  onToggle,
}: {
  tool: McpToolSummary;
  serverEnabled: boolean;
  shorten: boolean;
  onToggle: (toolId: string, patch: { enabled?: boolean; cronSafe?: boolean }) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const short = shorten && tool.originalName.startsWith("browser_") ? tool.originalName.slice("browser_".length) : tool.originalName;

  return (
    <div className="rounded-md border px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <button onClick={() => setExpanded(!expanded)} className="shrink-0" aria-label={expanded ? "Collapse" : "Expand"}>
          <ChevronRight className={`size-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{short}</span>
            </TooltipTrigger>
            {short !== tool.originalName && (
              <TooltipContent>
                <p className="font-mono text-xs">{tool.originalName}</p>
              </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
        {serverEnabled && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={scrollToCronJobs}
                  className={`shrink-0 ${tool.cronSafe ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  aria-label="Open scheduled runs"
                >
                  <CalendarClock className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">Scheduled runs{tool.cronSafe ? " allowed" : " off"} — open cron settings</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        <Switch checked={tool.enabled} onCheckedChange={(v) => onToggle(tool.id, { enabled: v })} />
      </div>
      {expanded && (
        <div className="mt-1 space-y-1.5 pl-6">
          {tool.description && <p className="text-muted-foreground text-xs">{tool.description}</p>}
          {serverEnabled && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-[11px]">Allow in scheduled runs</span>
              <Switch checked={tool.cronSafe} onCheckedChange={(v) => onToggle(tool.id, { cronSafe: v })} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
