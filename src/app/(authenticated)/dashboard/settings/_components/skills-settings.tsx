"use client";

import { useEffect, useMemo, useState } from "react";
import { FileText, Plus, ChevronDown, Search } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { trpc } from "~/clients/trpc";
import { useInstanceId } from "~/hooks/use-instance-id";
import { SkillRow, type SkillListItem } from "./skill-row";
import { SkillViewerDialog } from "./skill-viewer-dialog";
import { SkillEditorDialog, type SkillEditorMode } from "./skill-editor-dialog";
import { SkillTrustDialog } from "./skill-trust-dialog";
import { SkillImportDialog } from "./skill-import-dialog";
import { SkillDiscover } from "./skill-discover";
import { SkillsSettingsSkeleton } from "./skills-settings.skeleton";

type TrustFilter = "all" | "untrusted" | "verified" | "trusted";
type OriginFilter = "all" | "authored" | "imported" | "bundled";
type EnabledFilter = "all" | "enabled" | "disabled";
type SortKey = "updated" | "lastUsed" | "name" | "useCount";

const GROUPS: Array<{ origin: string; heading: string }> = [
  { origin: "authored", heading: "Created by you" },
  { origin: "imported", heading: "Imported" },
  { origin: "bundled", heading: "Bundled" },
];

const selectClass =
  "rounded-md border border-border/60 bg-background px-1.5 py-1 text-[12px] text-muted-foreground";

/**
 * Settings → Skills (§6.3): grouped list with badges, search/filter/sort,
 * row overflow actions, instruction viewer with scan findings, trust-tier
 * promotion, create + import flows, and the Discover tab.
 */
export function SkillsSettings({ initialTab }: { initialTab?: "mine" | "discover" }) {
  const [instanceId] = useInstanceId();
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<"mine" | "discover">(initialTab ?? "mine");
  useEffect(() => {
    // Intentional hash-deep-link sync (not derived state).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  const [query, setQuery] = useState("");
  const [trust, setTrust] = useState<TrustFilter>("all");
  const [origin, setOrigin] = useState<OriginFilter>("all");
  const [enabled, setEnabled] = useState<EnabledFilter>("all");
  const [sort, setSort] = useState<SortKey>("updated");
  const [addOpen, setAddOpen] = useState(false);

  const [viewSlug, setViewSlug] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<SkillEditorMode | null>(null);
  const [trustSlug, setTrustSlug] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const list = trpc.nimitsJarvis.listSkills.useQuery({
    instanceId: instanceId ?? undefined,
    includeDisabled: true,
  });
  const update = trpc.nimitsJarvis.updateSkill.useMutation({
    onSuccess: () => void utils.nimitsJarvis.listSkills.invalidate(),
  });
  const remove = trpc.nimitsJarvis.deleteSkill.useMutation({
    onSuccess: () => void utils.nimitsJarvis.listSkills.invalidate(),
  });

  const items = useMemo(() => {
    const all = ((list.data?.items ?? []) as unknown as SkillListItem[]).filter(
      (s) =>
        (trust === "all" || s.trustTier === trust) &&
        (origin === "all" || s.origin === origin) &&
        (enabled === "all" ||
          (enabled === "enabled" ? s.enabled : !s.enabled)) &&
        (query.trim() === "" ||
          `${s.slug} ${s.description}`.toLowerCase().includes(query.trim().toLowerCase())),
    );
    const time = (d: string | Date | null | undefined) =>
      d ? new Date(d).getTime() : -1;
    all.sort((a, b) => {
      switch (sort) {
        case "name":
          return a.slug.localeCompare(b.slug);
        case "lastUsed":
          return time(b.lastUsedAt) - time(a.lastUsedAt);
        case "useCount":
          return b.useCount - a.useCount;
        default:
          return time(b.updatedAt) - time(a.updatedAt);
      }
    });
    return all;
  }, [list.data, query, trust, origin, enabled, sort]);

  const refresh = () => void utils.nimitsJarvis.listSkills.invalidate();
  const trustOf = (slug: string) =>
    ((list.data?.items ?? []) as unknown as SkillListItem[]).find((s) => s.slug === slug)
      ?.trustTier ?? "untrusted";

  if (list.isLoading) return <SkillsSettingsSkeleton />;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <FileText className="size-4" /> Skills
          </CardTitle>
          <Popover open={addOpen} onOpenChange={setAddOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" className="gap-1">
                <Plus className="size-3.5" /> Add <ChevronDown className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1.5" align="end">
              <button
                onClick={() => {
                  setAddOpen(false);
                  setEditorMode({ kind: "create" });
                }}
                className="w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
              >
                Create new skill
              </button>
              <button
                onClick={() => {
                  setAddOpen(false);
                  setImportOpen(true);
                }}
                className="w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
              >
                Import from URL or Git
              </button>
            </PopoverContent>
          </Popover>
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills"
              className="h-8 pl-7 text-[13px]"
            />
          </div>
          <select value={trust} onChange={(e) => setTrust(e.target.value as TrustFilter)} className={selectClass} aria-label="Filter by trust tier">
            <option value="all">All tiers</option>
            <option value="trusted">Trusted</option>
            <option value="verified">Verified</option>
            <option value="untrusted">Untrusted</option>
          </select>
          <select value={origin} onChange={(e) => setOrigin(e.target.value as OriginFilter)} className={selectClass} aria-label="Filter by origin">
            <option value="all">All origins</option>
            <option value="authored">Created by you</option>
            <option value="imported">Imported</option>
            <option value="bundled">Bundled</option>
          </select>
          <select value={enabled} onChange={(e) => setEnabled(e.target.value as EnabledFilter)} className={selectClass} aria-label="Filter by state">
            <option value="all">Enabled + disabled</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className={selectClass} aria-label="Sort skills">
            <option value="updated">Last edited</option>
            <option value="lastUsed">Last used</option>
            <option value="name">Name</option>
            <option value="useCount">Use count</option>
          </select>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex gap-1 border-b">
          {(["mine", "discover"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                tab === t
                  ? "border-b-2 border-primary px-2 pb-1.5 text-[13px] font-medium text-foreground"
                  : "px-2 pb-1.5 text-[13px] text-muted-foreground hover:text-foreground"
              }
            >
              {t === "mine" ? "Your skills" : "Discover"}
            </button>
          ))}
        </div>
        {tab === "discover" ? (
          <SkillDiscover onInstalled={refresh} />
        ) : items.length === 0 ? (
          <div className="space-y-3 py-6 text-center">
            <p className="mx-auto max-w-md text-[13px] text-muted-foreground">
              {list.data?.items?.length
                ? "No skills match the current search or filters."
                : "A skill is instructions for how and when to do something — procedure and judgement the model follows. It executes nothing itself; that is what tools are for."}
            </p>
            {!list.data?.items?.length && (
              <Button size="sm" onClick={() => setEditorMode({ kind: "create" })}>
                <Plus className="size-3.5" /> Create new skill
              </Button>
            )}
          </div>
        ) : (
          GROUPS.map((g) => {
            const group = items.filter((s) => s.origin === g.origin);
            if (group.length === 0) return null;
            return (
              <div key={g.origin} className="mb-4 last:mb-0">
                <div className="px-2 pb-1 text-[12px] font-medium text-muted-foreground">
                  {g.heading} · {group.length}
                </div>
                {group.map((s) => (
                  <SkillRow
                    key={s.slug}
                    skill={s}
                    busy={update.isPending || remove.isPending}
                    onView={() => setViewSlug(s.slug)}
                    onEdit={() => setEditorMode({ kind: "edit", slug: s.slug })}
                    onTrust={() => setTrustSlug(s.slug)}
                    onToggleEnable={() =>
                      update.mutate({ slug: s.slug, enabled: !s.enabled })
                    }
                    onDelete={() => {
                      if (
                        window.confirm(
                          `Delete skill "${s.slug}"? Its directory is removed and this cannot be undone.`,
                        )
                      ) {
                        remove.mutate({ slug: s.slug });
                      }
                    }}
                  />
                ))}
              </div>
            );
          })
        )}
      </CardContent>

      <SkillViewerDialog
        slug={viewSlug}
        onClose={() => setViewSlug(null)}
        canEdit={
          viewSlug
            ? ((list.data?.items ?? []) as unknown as SkillListItem[]).find(
                (s) => s.slug === viewSlug,
              )?.origin === "authored"
            : false
        }
        onEdit={() => {
          if (viewSlug) setEditorMode({ kind: "edit", slug: viewSlug });
          setViewSlug(null);
        }}
      />
      <SkillEditorDialog
        mode={editorMode}
        onClose={() => setEditorMode(null)}
        onSaved={() => {
          setEditorMode(null);
          refresh();
        }}
      />
      <SkillTrustDialog
        slug={trustSlug}
        current={trustSlug ? trustOf(trustSlug) : "untrusted"}
        onClose={() => setTrustSlug(null)}
        onSaved={() => {
          setTrustSlug(null);
          refresh();
        }}
      />
      <SkillImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onSaved={() => {
          setImportOpen(false);
          refresh();
        }}
      />
    </Card>
  );
}
