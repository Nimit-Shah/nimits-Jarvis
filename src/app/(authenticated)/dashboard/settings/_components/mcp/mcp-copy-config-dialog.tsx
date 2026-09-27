"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "~/components/ui/dialog";
import { trpc } from "~/clients/trpc";

const SKIPPED = ["cdpEndpoint", "executablePath", "userDataDir", "cdpConfirmed"];

export function McpCopyConfigDialog({ serverId, instanceId }: { serverId: string; instanceId: string }) {
  const [open, setOpen] = useState(false);
  const [sourceId, setSourceId] = useState("");
  const utils = trpc.useUtils();
  const sources = trpc.mcp.listBrowserRows.useQuery({}, { enabled: open });
  const diff = trpc.mcp.diffBrowserConfig.useQuery(
    { serverIdA: sourceId, serverIdB: serverId },
    { enabled: open && !!sourceId },
  );
  const copy = trpc.mcp.copyBrowserConfig.useMutation({
    onSuccess: () => {
      void utils.mcp.listMcpServers.invalidate({ instanceId });
      setOpen(false);
      setSourceId("");
    },
  });

  const options = (sources.data ?? []).filter((s) => s.id !== serverId);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="flex w-full items-center rounded-sm px-2 py-1.5 text-xs hover:bg-accent">
          Copy browser config…
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Copy browser config</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <select
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
          >
            <option value="">Copy from…</option>
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.instanceName} / {s.label}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-[11px]">
            Copies policy only. Never copied: {SKIPPED.join(", ")} — targets stay per-row.
          </p>
          {diff.data && (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
              {diff.data.fields.length === 0 && diff.data.onlyA.length === 0 && diff.data.onlyB.length === 0 ? (
                <p className="text-xs text-green-600">Identical — no drift.</p>
              ) : (
                <>
                  {diff.data.fields.map((f) => (
                    <p key={f.field} className="font-mono text-[11px]">
                      {f.field}: <span className="text-muted-foreground">{JSON.stringify(f.a)}</span> → {JSON.stringify(f.b)}
                    </p>
                  ))}
                  {diff.data.onlyA.map((r) => (
                    <p key={`a-${r}`} className="font-mono text-[11px] text-amber-600">
                      rule only on source: {r}
                    </p>
                  ))}
                  {diff.data.onlyB.map((r) => (
                    <p key={`b-${r}`} className="font-mono text-[11px] text-amber-600">
                      rule only here: {r}
                    </p>
                  ))}
                </>
              )}
            </div>
          )}
          {copy.error && <p className="text-destructive text-xs">{copy.error.message}</p>}
          <Button
            disabled={!sourceId || copy.isPending}
            className="w-full"
            onClick={() => void copy.mutateAsync({ sourceServerId: sourceId, targetServerId: serverId })}
          >
            {copy.isPending ? <Loader2 className="size-3 animate-spin" /> : "Copy policy (targets untouched)"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
