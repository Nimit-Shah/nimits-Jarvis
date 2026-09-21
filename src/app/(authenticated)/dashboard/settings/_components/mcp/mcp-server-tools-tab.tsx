"use client";

import { useState } from "react";
import { trpc } from "~/clients/trpc";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { McpToolRow } from "./mcp-tool-row";

export function McpServerToolsTab({
  serverId,
  serverEnabled,
  isPlaywright,
}: {
  serverId: string;
  serverEnabled: boolean;
  isPlaywright: boolean;
}) {
  const [filter, setFilter] = useState("");
  const utils = trpc.useUtils();
  const { data: tools, isLoading } = trpc.mcp.listMcpTools.useQuery({ serverId });
  const toggle = trpc.mcp.toggleMcpTool.useMutation({
    onSuccess: () => {
      void utils.mcp.listMcpTools.invalidate({ serverId });
      void utils.mcp.listMcpServers.invalidate();
    },
  });

  if (isLoading) return <p className="text-muted-foreground p-3 text-xs">Loading tools…</p>;
  if (!tools || tools.length === 0) return <p className="text-muted-foreground p-3 text-xs">No tools discovered. Try Sync.</p>;

  const q = filter.trim().toLowerCase();
  const visible = q ? tools.filter((t) => t.originalName.toLowerCase().includes(q)) : tools;
  const enabledCount = tools.filter((t) => t.enabled).length;
  const allOn = enabledCount === tools.length;

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tools…"
          className="h-7 text-xs"
        />
        <span className="text-muted-foreground shrink-0 text-xs">
          {enabledCount} of {tools.length} on
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 text-xs"
          onClick={() => {
            for (const t of tools) {
              if (t.enabled !== !allOn) void toggle.mutateAsync({ toolId: t.id, enabled: !allOn });
            }
          }}
        >
          {allOn ? "Disable all" : "Enable all"}
        </Button>
      </div>
      {visible.length === 0 ? (
        <p className="text-muted-foreground text-xs">No tools match “{filter}”.</p>
      ) : (
        <div className="space-y-1.5">
          {visible.map((tool) => (
            <McpToolRow
              key={tool.id}
              tool={tool}
              serverEnabled={serverEnabled}
              shorten={isPlaywright}
              onToggle={(toolId, patch) => void toggle.mutateAsync({ toolId, ...patch })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
