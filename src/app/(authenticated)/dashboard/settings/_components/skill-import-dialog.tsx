"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { trpc } from "~/clients/trpc";

interface ImportFinding {
  rule: string;
  detail: string;
}

/**
 * Import from URL or git. The result lands untrusted and its scan findings
 * are shown before anything else — review, then promote explicitly.
 */
export function SkillImportDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const utils = trpc.useUtils();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    slug: string;
    findings: ImportFinding[];
  } | null>(null);
  const importSkill = trpc.nimitsJarvis.importSkill.useMutation();

  const close = () => {
    setUrl("");
    setError(null);
    setDone(null);
    onClose();
  };

  const submit = async () => {
    setError(null);
    setDone(null);
    try {
      const res = await importSkill.mutateAsync({ url: url.trim() });
      setDone({ slug: res.slug, findings: res.findings });
      await utils.nimitsJarvis.listSkills.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import from URL or Git</DialogTitle>
          <DialogDescription>
            A git repo URL or a raw SKILL.md URL. Imports always land{" "}
            <strong>untrusted</strong> — review the findings, then promote.
          </DialogDescription>
        </DialogHeader>
        {!done ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="skill-import-url">URL</Label>
              <Input
                id="skill-import-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/org/agent-skills or https://…/SKILL.md"
                className="font-mono text-[12px]"
              />
            </div>
            {error && <p className="text-[13px] text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close} disabled={importSkill.isPending}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={importSkill.isPending || !url.trim()}>
                {importSkill.isPending ? "Importing…" : "Import"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="flex items-center gap-1.5 text-[13px]">
              <CheckCircle2 className="size-4 text-emerald-500" />
              Imported <span className="font-mono font-medium">{done.slug}</span> as untrusted.
            </p>
            {done.findings.length > 0 ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="size-3.5" />
                  Scan findings ({done.findings.length})
                </div>
                <ul className="space-y-1">
                  {done.findings.map((f, i) => (
                    <li key={i} className="text-[12px] text-muted-foreground">
                      <span className="font-mono text-[11px] text-amber-600 dark:text-amber-400">
                        {f.rule}
                      </span>
                      {" — "}
                      {f.detail}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-[12px] text-muted-foreground">No scan findings.</p>
            )}
            <div className="flex justify-end">
              <Button onClick={() => { setDone(null); onSaved(); }}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
