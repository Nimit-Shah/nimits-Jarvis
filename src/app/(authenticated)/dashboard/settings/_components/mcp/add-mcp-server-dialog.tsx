"use client";

import { useState, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { trpc } from "~/clients/trpc";
import { McpReachabilityBadge } from "./mcp-reachability-badge";
import { classifyReachability } from "~/lib/mcp-url";

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

export function AddMcpServerDialog({ instanceId, onAdded }: { instanceId: string; onAdded?: () => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [url, setUrl] = useState("");
  const [headersJson, setHeadersJson] = useState("");
  const [showAuth, setShowAuth] = useState(false);

  const utils = trpc.useUtils();
  const add = trpc.mcp.addMcpServer.useMutation({
    onSuccess: () => {
      void utils.mcp.listMcpServers.invalidate({ instanceId });
      setOpen(false);
      setLabel("");
      setSlug("");
      setSlugEdited(false);
      setUrl("");
      setHeadersJson("");
      onAdded?.();
    },
  });

  const reachability = useMemo(() => {
    try {
      return classifyReachability(url);
    } catch {
      return null;
    }
  }, [url]);

  const handleLabelChange = (v: string) => {
    setLabel(v);
    if (!slugEdited) setSlug(slugify(v));
  };

  const handleSubmit = () => {
    let headers: Record<string, string> | undefined;
    if (headersJson.trim()) {
      try {
        headers = JSON.parse(headersJson);
      } catch {
        return;
      }
    }
    add.mutate({ instanceId, label: label.trim(), name: slug.trim(), url: url.trim(), headers });
  };

  const prefix = slug ? `mcp__${slug}__` : "mcp__…";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Add MCP server</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add MCP server</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Display name</Label>
            <Input placeholder="Vibe-trading" value={label} onChange={(e) => handleLabelChange(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Slug</Label>
            <Input
              placeholder="vibe-trading"
              value={slug}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
              }}
            />
            <p className="text-muted-foreground text-xs">Tool prefix: {prefix}…</p>
          </div>
          <div className="space-y-1.5">
            <Label>Server URL</Label>
            <div className="flex items-center gap-2">
              <Input placeholder="http://127.0.0.1:3845/mcp" value={url} onChange={(e) => setUrl(e.target.value)} className="flex-1" />
              {reachability && <McpReachabilityBadge reachability={reachability} />}
            </div>
          </div>
          <div className="space-y-1.5">
            <button type="button" onClick={() => setShowAuth(!showAuth)} className="text-primary text-xs hover:underline">
              {showAuth ? "Hide authentication" : "Add authentication"}
            </button>
            {showAuth && (
              <div className="space-y-1">
                <Label>Headers JSON (optional)</Label>
                <Input placeholder='{"Authorization":"Bearer ..."}' value={headersJson} onChange={(e) => setHeadersJson(e.target.value)} />
                <p className="text-muted-foreground text-xs">Values are encrypted and never shown again.</p>
              </div>
            )}
          </div>
          {add.error && <p className="text-destructive text-xs">{add.error.message}</p>}
          <Button onClick={handleSubmit} disabled={!label || !slug || !url || add.isPending} className="w-full">
            {add.isPending ? "Adding…" : "Add server"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
