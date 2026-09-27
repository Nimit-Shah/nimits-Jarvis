"use client";

import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import { useState } from "react";
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
  const [attachPhrase, setAttachPhrase] = useState("");
  const [copied, setCopied] = useState(false);

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
          <Button
            variant={server.browserMode === "cdp" ? "default" : "outline"}
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => void update.mutateAsync({ serverId: server.id, browserMode: "cdp" })}
          >
            Live attach
          </Button>
        </div>
      </div>
      {server.browserMode === "cdp" && (
        <div className="space-y-1.5 rounded-md border p-2">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground shrink-0 text-[11px]">CDP endpoint</span>
            <input
              defaultValue={server.cdpEndpoint ?? ""}
              placeholder="http://127.0.0.1:9222"
              className="h-6 min-w-0 flex-1 rounded-md border px-2 font-mono text-[11px]"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (server.cdpEndpoint ?? "")) void update.mutateAsync({ serverId: server.id, cdpEndpoint: v || null });
              }}
            />
          </div>
          {!server.cdpConfirmed ? (
            <div className="flex items-center gap-2">
              <input
                value={attachPhrase}
                onChange={(e) => setAttachPhrase(e.target.value)}
                placeholder='Type ATTACH to confirm live attach'
                className="h-6 min-w-0 flex-1 rounded-md border px-2 font-mono text-[11px]"
              />
              <Button
                size="sm"
                className="h-6 shrink-0 text-[11px]"
                disabled={attachPhrase !== "ATTACH" || update.isPending}
                onClick={() => {
                  setAttachPhrase("");
                  void update.mutateAsync({ serverId: server.id, cdpConfirmPhrase: "ATTACH" });
                }}
              >
                Confirm
              </Button>
            </div>
          ) : (
            <p className="text-[11px] text-green-600">Live attach confirmed — web chats only, never cron or Telegram.</p>
          )}
          <button
            className="text-muted-foreground text-[11px] hover:underline"
            onClick={() => {
              const cmd = `/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9223 --user-data-dir="$HOME/Library/Application Support/NimitsJarvis/browser/cdp-throwaway"`;
              void navigator.clipboard.writeText(cmd).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              });
            }}
          >
            {copied ? "Copied — run in a terminal" : "Copy throwaway-Chromium launch command (:9223)"}
          </button>
        </div>
      )}
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
      {server.sharedPort && server.sharedPort.participants.length > 0 && (
        <p className="text-muted-foreground text-[11px]">
          Shared browser on :{server.sharedPort.port} with{" "}
          {server.sharedPort.participants.map((p) => `${p.instanceName} / ${p.label}`).join(", ")} — one child serves all rows.
        </p>
      )}
      {server.sandboxOverridden && (
        <p className="text-[11px] text-amber-600">Sandbox kept on: another row on this port requires it (strictest wins).</p>
      )}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">Site access</span>
        <Hint text="Open: no restriction. Allowlist: only listed sites plus shared CDNs." />
        {server.browserMode === "cdp" && (
          <span className="text-muted-foreground text-[10px]">Under Live attach, the allowlist covers what Jarvis fetches, not tabs you open yourself.</span>
        )}
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
          {server.siblingBlocks && server.siblingBlocks.length > 0 && (
            <p className="text-[11px] text-amber-600">
              Also blocked for you via {[...new Set(server.siblingBlocks.map((b) => b.byLabel))].join(", ")}:{" "}
              {server.siblingBlocks.map((b) => b.pattern).join(", ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
