"use client";

import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import { trpc } from "~/clients/trpc";
import { McpDomainsTable } from "./mcp-domains-table";
import { McpCdnSheet } from "./mcp-cdn-sheet";
import type { McpServerSummary } from "./mcp-server-type";

function Hint({ text }: { text: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-muted-foreground cursor-help text-[11px]">?</span>
        </TooltipTrigger>
        <TooltipContent>
          <p className="max-w-[220px] text-xs">{text}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function McpBrowserTab({ server, instanceId }: { server: McpServerSummary; instanceId: string }) {
  const utils = trpc.useUtils();
  const refresh = () => void utils.mcp.listMcpServers.invalidate({ instanceId });
  const update = trpc.mcp.updateMcpServer.useMutation({ onSuccess: refresh });

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">Browser</span>
        <Hint text="Managed: daemon launches an isolated browser. Live Comet: drives your open Comet windows with your logins." />
        <div className="ml-auto flex gap-1">
          <Button
            variant={server.browserMode !== "extension" ? "default" : "outline"}
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => void update.mutateAsync({ serverId: server.id, browserMode: "bundled" })}
          >
            Managed
          </Button>
          <Button
            variant={server.browserMode === "extension" ? "default" : "outline"}
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => void update.mutateAsync({ serverId: server.id, browserMode: "extension" })}
          >
            Live Comet
          </Button>
        </div>
      </div>
      {server.browserMode === "extension" && (
        <div className="space-y-1.5 rounded-md border border-amber-200 bg-amber-50 p-2">
          <label className="flex items-start gap-2 text-[11px]">
            <Switch
              checked={server.extensionConfirmed ?? false}
              onCheckedChange={(v) => void update.mutateAsync({ serverId: server.id, extensionConfirmed: v })}
              className="mt-0.5"
            />
            <span>I understand Jarvis can act in my open Comet windows with my logins. Token comes from .env, never stored here.</span>
          </label>
          {!server.extensionConfirmed && (
            <p className="text-muted-foreground pl-7 text-[11px]">Tools stay hidden until confirmed — and only in web chats, never cron or Telegram.</p>
          )}
          <div className="flex items-center gap-2 pl-7">
            <span className="text-muted-foreground text-[11px]">Browser binary (Comet needs this set)</span>
            <input
              defaultValue={server.executablePath ?? ""}
              placeholder="/Applications/Comet.app/Contents/MacOS/Comet"
              className="h-6 min-w-0 flex-1 rounded-md border px-2 font-mono text-[11px]"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (server.executablePath ?? "")) void update.mutateAsync({ serverId: server.id, executablePath: v || null });
              }}
            />
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">Sandbox</span>
        <Hint
          text={
            server.browserMode === "extension"
              ? "No launched browser in Live mode — nothing to sandbox."
              : "Chromium sandbox. Turn off only for Docker or root — never on macOS."
          }
        />
        <Switch
          checked={!server.noSandbox}
          onCheckedChange={(v) => void update.mutateAsync({ serverId: server.id, noSandbox: !v })}
          className="ml-auto"
        />
        <span className="text-muted-foreground text-[11px]">{server.noSandbox ? "Off" : "On"}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">Site access</span>
        <Hint text="Open: no restriction. Allowlist: only listed sites plus shared CDNs." />
        <div className="ml-auto flex gap-1">
          <Button
            variant={server.originMode === "open" ? "default" : "outline"}
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => void update.mutateAsync({ serverId: server.id, originMode: "open" })}
          >
            Open
          </Button>
          <Button
            variant={server.originMode === "allowlist" ? "default" : "outline"}
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => void update.mutateAsync({ serverId: server.id, originMode: "allowlist" })}
          >
            Allowlist
          </Button>
        </div>
        {server.policyApplying && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">Applying…</span>
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-[220px] text-xs">Policy change is restarting the browser session. Logins persist.</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {server.originMode === "allowlist" && (
        <div className="space-y-3">
          <McpCdnSheet
            serverId={server.id}
            instanceId={instanceId}
            seedEnabled={server.infraSeedEnabled}
            excluded={server.infraSeedExcluded}
          />
          <McpDomainsTable serverId={server.id} instanceId={instanceId} />
        </div>
      )}
    </div>
  );
}
