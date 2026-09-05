"use client";

import { useState } from "react";
import { FolderOpen, ShieldAlert, PenLine } from "lucide-react";
import { trpc } from "~/clients/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Input } from "~/components/ui/input";

export function FsSettings({
  instanceId,
  fsReadEnabled,
  fsWriteAllowed,
  fsRootPath,
}: {
  instanceId: string;
  fsReadEnabled: boolean;
  fsWriteAllowed: boolean;
  fsRootPath?: string | null;
}) {
  const utils = trpc.useUtils();
  const update = trpc.nimitsJarvis.updateSettings.useMutation({
    onSuccess: () => void utils.nimitsJarvis.getInstance.invalidate({ instanceId }),
  });

  const [readEnabled, setReadEnabled] = useState(fsReadEnabled ?? true);
  const [writeAllowed, setWriteAllowed] = useState(fsWriteAllowed ?? false);
  const [root, setRoot] = useState(fsRootPath ?? "");

  const saveRoot = () => {
    if (root === (fsRootPath ?? "")) return;
    void update.mutateAsync({
      instanceId,
      // empty string clears back to home (server maps "" → null)
      fsRootPath: root.trim() === "" ? null : root.trim(),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderOpen className="size-4" /> File Access
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Read ceiling */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <FolderOpen className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            <div className="space-y-0.5">
              <Label htmlFor="fs-read" className="cursor-pointer text-sm font-semibold">
                Read files
              </Label>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Let the agent list directories and read files on this Mac.
              </p>
            </div>
          </div>
          <Switch
            id="fs-read"
            checked={readEnabled}
            onCheckedChange={(checked) => {
              setReadEnabled(checked);
              void update.mutateAsync({ instanceId, fsReadEnabled: checked });
            }}
            disabled={update.isPending}
          />
        </div>

        {/* Write ceiling */}
        <div className="flex items-start justify-between gap-4 border-t pt-4">
          <div className="flex items-start gap-3">
            <PenLine className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <div className="space-y-0.5">
              <Label htmlFor="fs-write" className="cursor-pointer text-sm font-semibold">
                Write files
              </Label>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Unlock Full System Access in a conversation; every change still asks first.
              </p>
            </div>
          </div>
          <Switch
            id="fs-write"
            checked={writeAllowed}
            onCheckedChange={(checked) => {
              setWriteAllowed(checked);
              void update.mutateAsync({ instanceId, fsWriteAllowed: checked });
            }}
            disabled={update.isPending}
          />
        </div>

        {/* Root override */}
        <div className="space-y-1.5 border-t pt-4">
          <Label htmlFor="fs-root" className="text-xs font-semibold">
            Root folder
          </Label>
          <Input
            id="fs-root"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            onBlur={saveRoot}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            placeholder="~/ (Home Directory)"
            className="h-8 text-xs"
            maxLength={500}
            disabled={update.isPending}
          />
          <p className="text-muted-foreground text-[11px]">
            Restricts agent access to a specific subfolder.
          </p>
        </div>

        {/* macOS TCC note — the single most likely support question */}
        <div className="flex gap-2 rounded-md border border-border/60 bg-muted/20 p-3">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground text-[11px] leading-relaxed">
            If Desktop, Documents, or Downloads look empty, grant Full Disk Access to
            the app that runs Jarvis in System Settings → Privacy &amp; Security,
            then restart it.
          </p>
        </div>

        {update.isPending && <p className="text-muted-foreground text-[11px]">Saving…</p>}
      </CardContent>
    </Card>
  );
}
