"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";
import { trpc } from "~/clients/trpc";
import { infraSeedFlat } from "~/server/lib/browser/infra-origins";

export function McpOriginRules({
  serverId,
  instanceId,
  originMode,
  policyApplying,
  noSandbox,
  infraSeedEnabled,
  infraSeedExcluded,
}: {
  serverId: string;
  instanceId: string;
  originMode: string;
  policyApplying: boolean;
  noSandbox: boolean;
  infraSeedEnabled: boolean;
  infraSeedExcluded: string[];
}) {
  const [pattern, setPattern] = useState("");
  const [customising, setCustomising] = useState(false);
  const utils = trpc.useUtils();
  const refresh = () => {
    void utils.mcp.listMcpServers.invalidate({ instanceId });
    void utils.mcp.listMcpOriginRules.invalidate({ serverId });
  };
  const rules = trpc.mcp.listMcpOriginRules.useQuery({ serverId });
  const candidates = trpc.mcp.listSeedCandidates.useQuery({ instanceId });
  const add = trpc.mcp.addMcpOriginRule.useMutation({ onSuccess: () => (setPattern(""), refresh()) });
  const toggle = trpc.mcp.toggleMcpOriginRule.useMutation({ onSuccess: refresh });
  const remove = trpc.mcp.deleteMcpOriginRule.useMutation({ onSuccess: refresh });
  const setMode = trpc.mcp.updateMcpServer.useMutation({ onSuccess: refresh });
  const setSandbox = trpc.mcp.updateMcpServer.useMutation({ onSuccess: refresh });
  const setSeed = trpc.mcp.updateMcpServer.useMutation({ onSuccess: refresh });
  const seedActive = (entry: string) => infraSeedEnabled && !infraSeedExcluded.includes(entry);
  const toggleExcluded = (entry: string) => {
    const next = infraSeedExcluded.includes(entry) ? infraSeedExcluded.filter((e) => e !== entry) : [...infraSeedExcluded, entry];
    void setSeed.mutateAsync({ serverId, infraSeedExcluded: next });
  };

  return (
    <div className="space-y-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">Sandbox</span>
        <Switch checked={!noSandbox} onCheckedChange={(v) => void setSandbox.mutateAsync({ serverId, noSandbox: !v })} />
        <span className="text-muted-foreground text-[11px]">
          {noSandbox ? "OFF — Docker/root only, do not disable on macOS" : "On"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">Origin policy</span>
        <Button
          variant={originMode === "open" ? "default" : "outline"}
          size="sm"
          className="h-6 text-[11px]"
          onClick={() => void setMode.mutateAsync({ serverId, originMode: "open" })}
        >
          Open
        </Button>
        <Button
          variant={originMode === "allowlist" ? "default" : "outline"}
          size="sm"
          className="h-6 text-[11px]"
          onClick={() => void setMode.mutateAsync({ serverId, originMode: "allowlist" })}
        >
          Allowlist
        </Button>
        {policyApplying && (
          <span className="text-[11px] text-amber-600">Applying — browser session will restart (logins persist)</span>
        )}
      </div>
      {originMode === "allowlist" && (
        <>
          <div className="rounded-md border p-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">Shared infrastructure</span>
              <Switch
                checked={infraSeedEnabled}
                onCheckedChange={(v) => void setSeed.mutateAsync({ serverId, infraSeedEnabled: v })}
              />
              <button onClick={() => setCustomising(!customising)} className="text-muted-foreground ml-auto text-[11px] underline">
                Customise
              </button>
            </div>
            <p className="text-muted-foreground mt-1 text-[11px]">Fonts, icons and JS library CDNs used across many sites.</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {infraSeedFlat().map((entry) => (
                <span
                  key={entry}
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${seedActive(entry) ? "bg-accent" : "text-muted-foreground line-through"}`}
                >
                  {entry}
                </span>
              ))}
            </div>
            {customising && (
              <div className="mt-1 space-y-1">
                {infraSeedFlat().map((entry) => (
                  <label key={entry} className="flex items-center gap-2 text-[11px]">
                    <input type="checkbox" checked={seedActive(entry)} onChange={() => toggleExcluded(entry)} />
                    <span className="font-mono">{entry}</span>
                  </label>
                ))}
              </div>
            )}
            {candidates.data?.map((c) => (
              <p key={c.pattern} className="mt-1 text-[11px] text-amber-600">
                {c.pattern} — seen on {c.serverCount} sites, consider adding to the seed list.
              </p>
            ))}
          </div>
          <p className="text-muted-foreground text-[11px]">
            Bare sites expand to apex + all subdomains (e.g. tradingview.com covers static.tradingview.com). Block wins over allow.
          </p>
          {rules.data?.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-xs">
              <Switch checked={r.enabled} onCheckedChange={(v) => void toggle.mutateAsync({ ruleId: r.id, enabled: v })} />
              <span className="min-w-0 flex-1 truncate font-mono">{r.pattern}</span>
              <span className="text-muted-foreground text-[10px]">
                {r.kind} · {r.origin}
              </span>
              <button onClick={() => void remove.mutateAsync({ ruleId: r.id })} className="text-destructive text-[11px]">
                Remove
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="tradingview.com"
              className="h-7 min-w-0 flex-1 rounded-md border px-2 font-mono text-xs"
            />
            <Button
              size="sm"
              className="h-7 text-[11px]"
              disabled={!pattern.trim() || add.isPending}
              onClick={() => void add.mutateAsync({ serverId, pattern: pattern.trim() })}
            >
              {add.isPending ? <Loader2 className="size-3 animate-spin" /> : "Add"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
