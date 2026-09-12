"use client";

import { useState } from "react";
import { FileText, Download, Check } from "lucide-react";
import { Button } from "~/components/ui/button";
import { trpc } from "~/clients/trpc";

/**
 * Discover tab (§6.3): browse the static curated manifest. Installing reuses
 * the import flow — entries land untrusted like any other import.
 */
export function SkillDiscover({ onInstalled }: { onInstalled: () => void }) {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const discover = trpc.nimitsJarvis.getDiscover.useQuery({});
  const install = trpc.nimitsJarvis.importSkill.useMutation();

  const runInstall = async (entry: { slug: string; sourceRepo: string; subdir?: string }) => {
    setError(null);
    setBusy(entry.slug);
    try {
      await install.mutateAsync({
        url: entry.sourceRepo,
        slug: entry.slug,
        subdir: entry.subdir,
      });
      await utils.nimitsJarvis.getDiscover.invalidate();
      await utils.nimitsJarvis.listSkills.invalidate();
      onInstalled();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Install failed.");
    } finally {
      setBusy(null);
    }
  };

  if (discover.isLoading) {
    return <p className="py-4 text-center text-[13px] text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-1">
      <p className="px-2 pb-2 text-[12px] text-muted-foreground">
        A curated list of compatible skills. “Curated” describes the list —
        everything installed from here lands <strong>untrusted</strong> until you review and promote it.
      </p>
      {(discover.data?.entries ?? []).map((e) => (
        <div key={e.slug} className="flex items-start gap-2.5 rounded-md px-2 py-2">
          <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{e.slug}</div>
            <div className="truncate text-[11px] text-muted-foreground">{e.description}</div>
          </div>
          {e.installed ? (
            <span className="flex shrink-0 items-center gap-1 pt-0.5 text-[12px] text-emerald-600 dark:text-emerald-400">
              <Check className="size-3.5" /> Installed
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 gap-1 text-[12px]"
              disabled={busy !== null}
              onClick={() => void runInstall(e)}
            >
              <Download className="size-3.5" />
              {busy === e.slug ? "Installing…" : "Install"}
            </Button>
          )}
        </div>
      ))}
      {error && <p className="px-2 text-[13px] text-destructive">{error}</p>}
    </div>
  );
}
