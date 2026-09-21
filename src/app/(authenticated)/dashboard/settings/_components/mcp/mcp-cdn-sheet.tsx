"use client";

import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "~/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import { trpc } from "~/clients/trpc";
import { infraSeedFlat } from "~/server/lib/browser/infra-origins";

export function McpCdnSheet({
  serverId,
  instanceId,
  seedEnabled,
  excluded,
}: {
  serverId: string;
  instanceId: string;
  seedEnabled: boolean;
  excluded: string[];
}) {
  const utils = trpc.useUtils();
  const refresh = () => void utils.mcp.listMcpServers.invalidate({ instanceId });
  const candidates = trpc.mcp.listSeedCandidates.useQuery({ instanceId });
  const setSeed = trpc.mcp.updateMcpServer.useMutation({ onSuccess: refresh });

  const entries = infraSeedFlat();
  const allowedCount = entries.filter((e) => seedEnabled && !excluded.includes(e)).length;

  const toggleExcluded = (entry: string) => {
    const next = excluded.includes(entry) ? excluded.filter((e) => e !== entry) : [...excluded, entry];
    void setSeed.mutateAsync({ serverId, infraSeedExcluded: next });
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium">Shared CDNs</span>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-muted-foreground cursor-help text-[11px]">?</span>
          </TooltipTrigger>
          <TooltipContent>
            <p className="max-w-[220px] text-xs">Fonts, icons and library CDNs shared across sites. No trackers or ads.</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="outline" size="sm" className="ml-auto h-6 font-mono text-[11px]">
            {allowedCount}/{entries.length} allowed · Customize
          </Button>
        </SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Shared infrastructure CDNs</SheetTitle>
            <SheetDescription>Asset hosts used across many sites. Changes restart the browser session.</SheetDescription>
          </SheetHeader>
          <div className="mt-4 flex items-center gap-2">
            <Switch checked={seedEnabled} onCheckedChange={(v) => void setSeed.mutateAsync({ serverId, infraSeedEnabled: v })} />
            <span className="text-xs">Use shared CDN list</span>
          </div>
          <div className="mt-3 space-y-1.5">
            {entries.map((entry) => {
              const on = seedEnabled && !excluded.includes(entry);
              return (
                <label key={entry} className="flex items-center gap-2 text-xs">
                  <Switch checked={on} onCheckedChange={() => toggleExcluded(entry)} />
                  <span className="font-mono">{entry}</span>
                </label>
              );
            })}
          </div>
          {candidates.data?.map((c) => (
            <p key={c.pattern} className="mt-3 text-[11px] text-amber-600">
              {c.pattern} — seen on {c.serverCount} sites, consider adding to the seed list.
            </p>
          ))}
        </SheetContent>
      </Sheet>
    </div>
  );
}
