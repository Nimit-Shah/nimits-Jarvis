"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Table, TableBody, TableCell, TableRow } from "~/components/ui/table";
import { trpc } from "~/clients/trpc";

export function McpDomainsTable({ serverId, instanceId }: { serverId: string; instanceId: string }) {
  const [pattern, setPattern] = useState("");
  const utils = trpc.useUtils();
  const refresh = () => {
    void utils.mcp.listMcpServers.invalidate({ instanceId });
    void utils.mcp.listMcpOriginRules.invalidate({ serverId });
  };
  const rules = trpc.mcp.listMcpOriginRules.useQuery({ serverId });
  const add = trpc.mcp.addMcpOriginRule.useMutation({ onSuccess: () => (setPattern(""), refresh()) });
  const toggle = trpc.mcp.toggleMcpOriginRule.useMutation({ onSuccess: refresh });
  const remove = trpc.mcp.deleteMcpOriginRule.useMutation({ onSuccess: refresh });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="+ Add domain (e.g. tradingview.com)"
          className="h-7 font-mono text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter" && pattern.trim()) void add.mutateAsync({ serverId, pattern: pattern.trim() });
          }}
        />
        <Button
          size="sm"
          className="h-7 shrink-0 text-[11px]"
          disabled={!pattern.trim() || add.isPending}
          onClick={() => void add.mutateAsync({ serverId, pattern: pattern.trim() })}
        >
          Add
        </Button>
      </div>
      {rules.data && rules.data.length > 0 && (
        <Table>
          <TableBody>
            {rules.data.map((r) => (
              <TableRow key={r.id} className="border-0">
                <TableCell className="px-1 py-1">
                  <Switch checked={r.enabled} onCheckedChange={(v) => void toggle.mutateAsync({ ruleId: r.id, enabled: v })} />
                </TableCell>
                <TableCell className="px-1 py-1">
                  <span className="font-mono text-xs">{r.pattern}</span>
                </TableCell>
                <TableCell className="px-1 py-1">
                  {r.kind === "block" ? (
                    <span className="text-destructive text-[10px]">blocked</span>
                  ) : r.origin === "discovered" ? (
                    <span className="text-muted-foreground text-[10px]">found automatically</span>
                  ) : null}
                </TableCell>
                <TableCell className="px-1 py-1 text-right">
                  <button
                    onClick={() => void remove.mutateAsync({ ruleId: r.id })}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${r.pattern}`}
                  >
                    <X className="size-3.5" />
                  </button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
