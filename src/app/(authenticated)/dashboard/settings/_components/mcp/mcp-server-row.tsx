"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, MoreHorizontal } from "lucide-react";
import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { trpc } from "~/clients/trpc";
import { McpReachabilityBadge } from "./mcp-reachability-badge";
import { McpStatusBadge } from "./mcp-status-badge";
import { McpServerToolsTab } from "./mcp-server-tools-tab";
import { McpBrowserTab } from "./mcp-browser-tab";
import type { McpServerSummary } from "./mcp-server-type";

export function McpServerRow({ server, instanceId }: { server: McpServerSummary; instanceId: string }) {
  const [expanded, setExpanded] = useState(false);
  const utils = trpc.useUtils();
  const toggle = trpc.mcp.toggleMcpServer.useMutation({ onSuccess: () => void utils.mcp.listMcpServers.invalidate({ instanceId }) });
  const sync = trpc.mcp.syncMcpTools.useMutation({ onSuccess: () => void utils.mcp.listMcpServers.invalidate({ instanceId }) });
  const test = trpc.mcp.testMcpServer.useMutation({ onSuccess: () => void utils.mcp.listMcpServers.invalidate({ instanceId }) });
  const del = trpc.mcp.deleteMcpServer.useMutation({ onSuccess: () => void utils.mcp.listMcpServers.invalidate({ instanceId }) });

  const dimmed = !server.reachableHere;
  const isPlaywright = server.serverType === "playwright";

  return (
    <div className={`rounded-md border ${dimmed ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={() => setExpanded(!expanded)} className="shrink-0" aria-label={expanded ? "Collapse" : "Expand"}>
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{server.label}</span>
        <McpReachabilityBadge reachability={server.reachability} />
        {dimmed ? (
          <span className="text-muted-foreground text-[10px]">unavailable on this deployment</span>
        ) : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1">
                  <McpStatusBadge status={server.status} needsSync={server.needsSync} />
                  {server.policyApplying && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">Applying…</span>
                  )}
                </span>
              </TooltipTrigger>
              {server.lastError && (
                <TooltipContent>
                  <p className="max-w-[260px] text-xs">{server.lastError}</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        )}
        <span className="text-muted-foreground whitespace-nowrap text-xs">
          {server.enabledToolCount}/{server.toolCount} tools
        </span>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7">
              <MoreHorizontal className="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-40 p-1">
            <button
              onClick={() => void sync.mutateAsync({ serverId: server.id })}
              disabled={sync.isPending}
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-xs hover:bg-accent"
            >
              {sync.isPending ? <Loader2 className="mr-2 size-3 animate-spin" /> : null} Sync tools
            </button>
            <button
              onClick={() => void test.mutateAsync({ serverId: server.id })}
              disabled={test.isPending}
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-xs hover:bg-accent"
            >
              {test.isPending ? <Loader2 className="mr-2 size-3 animate-spin" /> : null} Test connection
            </button>
            <button
              onClick={() => void del.mutateAsync({ serverId: server.id })}
              className="text-destructive flex w-full items-center rounded-sm px-2 py-1.5 text-xs hover:bg-accent"
            >
              Delete
            </button>
          </PopoverContent>
        </Popover>
        <Switch checked={server.enabled} onCheckedChange={(v) => void toggle.mutateAsync({ serverId: server.id, enabled: v })} />
      </div>
      {expanded && (
        <div className="border-t px-3 pt-2">
          <Tabs defaultValue="tools">
            <TabsList className="h-7">
              <TabsTrigger value="tools" className="text-[11px]">
                Tools
              </TabsTrigger>
              {isPlaywright && (
                <TabsTrigger value="browser" className="text-[11px]">
                  Browser
                </TabsTrigger>
              )}
            </TabsList>
            <TabsContent value="tools">
              <McpServerToolsTab serverId={server.id} serverEnabled={server.enabled} isPlaywright={isPlaywright} />
            </TabsContent>
            {isPlaywright && (
              <TabsContent value="browser">
                <McpBrowserTab server={server} instanceId={instanceId} />
              </TabsContent>
            )}
          </Tabs>
        </div>
      )}
      {test.data && (
        <p className={`px-3 pb-2 text-xs ${test.data.ok ? "text-green-600" : "text-destructive"}`}>
          {test.data.ok ? `Connected — ${test.data.toolCount} tools in ${test.data.latencyMs}ms` : `Failed: ${test.data.error}`}
        </p>
      )}
    </div>
  );
}
