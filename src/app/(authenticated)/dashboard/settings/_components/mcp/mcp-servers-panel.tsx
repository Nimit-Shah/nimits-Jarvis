"use client";

import { trpc } from "~/clients/trpc";
import { McpServerRow } from "./mcp-server-row";
import { AddMcpServerDialog } from "./add-mcp-server-dialog";
import { McpServersPanelSkeleton } from "./mcp-servers-panel.skeleton";

export function McpServersPanel({ instanceId }: { instanceId: string }) {
  const { data: servers, isLoading } = trpc.mcp.listMcpServers.useQuery({ instanceId });
  const { data: allTools } = trpc.mcp.listMcpServers.useQuery({ instanceId });

  if (isLoading) return <McpServersPanelSkeleton />;

  const totalEnabled = servers?.reduce((acc, s) => acc + s.enabledToolCount, 0) ?? 0;

  if (!servers || servers.length === 0) {
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-dashed p-6 text-center">
          <p className="text-foreground text-sm font-medium">No MCP servers yet</p>
          <p className="text-muted-foreground mt-1 text-xs">Connect a local server running on your machine, or a hosted one.</p>
          <div className="mt-4 flex justify-center">
            <AddMcpServerDialog instanceId={instanceId} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          {totalEnabled} tools enabled for this project
          {totalEnabled > 30 ? " — consider disabling some; accuracy degrades past ~30 tools." : ""}
        </p>
        <AddMcpServerDialog instanceId={instanceId} />
      </div>
      <div className="space-y-2">
        {servers.map((s) => (
          <McpServerRow key={s.id} server={s as never} instanceId={instanceId} />
        ))}
      </div>
    </div>
  );
}
