"use client";

import { useState } from "react";
import { trpc } from "~/clients/trpc";
import { Switch } from "~/components/ui/switch";
import { Label } from "~/components/ui/label";
import { Button } from "~/components/ui/button";

export function McpServerToolsList({ serverId, enabled }: { serverId: string; enabled: boolean }) {
  const utils = trpc.useUtils();
  const { data: tools, isLoading } = trpc.mcp.listMcpTools.useQuery({ serverId });
  const toggle = trpc.mcp.toggleMcpTool.useMutation({
    onSuccess: () => void utils.mcp.listMcpTools.invalidate({ serverId }),
  });

  if (isLoading) return <p className="text-muted-foreground p-3 text-xs">Loading tools…</p>;
  if (!tools || tools.length === 0) return <p className="text-muted-foreground p-3 text-xs">No tools discovered. Try Sync.</p>;

  const enabledCount = tools.filter((t) => t.enabled).length;

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          {enabledCount} of {tools.length} enabled
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            const shouldEnable = enabledCount < tools.length;
            for (const t of tools) {
              if (t.enabled !== shouldEnable) void toggle.mutateAsync({ toolId: t.id, enabled: shouldEnable });
            }
          }}
        >
          {enabledCount === tools.length ? "Disable all" : "Select all"}
        </Button>
      </div>
      <div className="space-y-2">
        {tools.map((tool) => (
          <div key={tool.id} className="flex items-start justify-between gap-2 rounded-md border px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-foreground truncate text-xs font-medium">{tool.originalName}</p>
              {tool.description && <McpToolDescription description={tool.description} />}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!enabled ? null : (
                <div className="flex items-center gap-1">
                  <Label className="text-[10px]">cron</Label>
                  <Switch
                    checked={tool.cronSafe}
                    onCheckedChange={(v) => void toggle.mutateAsync({ toolId: tool.id, cronSafe: v })}
                  />
                </div>
              )}
              <Switch checked={tool.enabled} onCheckedChange={(v) => void toggle.mutateAsync({ toolId: tool.id, enabled: v })} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Descriptions longer than ~2 lines render clamped with an inline read more / show less toggle. */
const READ_MORE_THRESHOLD = 140;

function McpToolDescription({ description }: { description: string }) {
  const [expanded, setExpanded] = useState(false);
  const overflowing = description.length > READ_MORE_THRESHOLD;

  return (
    <div>
      <p className={`text-muted-foreground text-xs ${expanded ? "" : "line-clamp-2"}`}>{description}</p>
      {overflowing && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs underline underline-offset-2 text-muted-foreground hover:text-foreground"
        >
          {expanded ? "show less" : "read more"}
        </button>
      )}
    </div>
  );
}
