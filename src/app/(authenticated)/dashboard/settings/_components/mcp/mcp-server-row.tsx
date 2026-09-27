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
import { McpCopyConfigDialog } from "./mcp-copy-config-dialog";
import type { McpServerSummary } from "./mcp-server-type";

export function McpServerRow({ server, instanceId }: { server: McpServerSummary; instanceId: string }) {
  const [expanded, setExpanded] = useState(false);
  const utils = trpc.useUtils();
  const toggle = trpc.mcp.toggleMcpServer.useMutation({ onSuccess: () => void utils.mcp.listMcpServers.invalidate({ instanceId }) });
  const sync = trpc.mcp.syncMcpTools.useMutation({ onSuccess: () => void utils.mcp.listMcpServers.invalidate({ instanceId }) });
  const test = trpc.mcp.testMcpServer.useMutation({ onSuccess: () => void utils.mcp.listMcpServers.invalidate({ instanceId }) });
  const del = trpc.mcp.deleteMcpServer.useMutation({ onSuccess: () => void utils.mcp.listMcpServers.invalidate({ instanceId }) });
  const setType = trpc.mcp.updateMcpServer.useMutation({
    onSuccess: () => void utils.mcp.listMcpServers.invalidate({ instanceId }),
  });

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
            <div className="my-1 border-t" />
            <p className="px-2 pt-1 text-[10px] text-muted-foreground">Server type</p>
            {(["generic", "playwright"] as const).map((t) => (
              <button
                key={t}
                onClick={() => void setType.mutateAsync({ serverId: server.id, serverType: t })}
                disabled={setType.isPending || server.serverType === t}
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-xs hover:bg-accent disabled:opacity-60"
              >
                {t === "playwright" ? "Browser (Playwright)" : "Generic"}
                {server.serverType === t && <span className="ml-auto text-[10px] text-muted-foreground">current</span>}
              </button>
            ))}
            {isPlaywright && (
              <>
                <div className="my-1 border-t" />
                <div className="flex items-center rounded-sm px-2 py-1.5 text-xs">
                  <span className="flex-1">Allow live attach</span>
                  <Switch
                    checked={server.cdpAllowed ?? false}
                    onCheckedChange={(v) => void setType.mutateAsync({ serverId: server.id, cdpAllowed: v })}
                  />
                </div>
                <McpCopyConfigDialog serverId={server.id} instanceId={instanceId} />
              </>
            )}
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
      {server.needsTypeConfirmation && server.serverType === "generic" && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5">
          <p className="flex-1 text-[11px]">This looks like a browser server. Set type to Browser (Playwright)?</p>
          <Button
            size="sm"
            className="h-6 text-[11px]"
            disabled={setType.isPending}
            onClick={() => void setType.mutateAsync({ serverId: server.id, serverType: "playwright" })}
          >
            Confirm
          </Button>
          <button
            onClick={() => void setType.mutateAsync({ serverId: server.id, dismissTypeConfirmation: true })}
            className="text-muted-foreground text-[11px] hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}
      {setType.error && <p className="text-destructive px-3 pb-2 text-xs">{setType.error.message}</p>}
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
