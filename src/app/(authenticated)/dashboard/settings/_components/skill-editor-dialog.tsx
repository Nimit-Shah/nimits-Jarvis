"use client";

import { useEffect, useState } from "react";
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
import { Textarea } from "~/components/ui/textarea";
import { trpc } from "~/clients/trpc";

export type SkillEditorMode =
  | { kind: "create" }
  | { kind: "edit"; slug: string };

/**
 * Create (scaffold) + Edit (body) dialog. Create bakes in trigger-condition
 * guidance via the server scaffold; edit validates frontmatter before saving
 * and refuses renames. Phase 7 adds template polish + authoring docs.
 */
export function SkillEditorDialog({
  mode,
  onClose,
  onSaved,
}: {
  mode: SkillEditorMode | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const utils = trpc.useUtils();
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  const existing = trpc.nimitsJarvis.getSkill.useQuery(
    { slug: mode?.kind === "edit" ? mode.slug : "" },
    { enabled: mode?.kind === "edit" },
  );

  useEffect(() => {
    // Intentional per-open reset (not derived state): dialog fields must
    // clear/reload each time it opens for a different skill.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);
    if (mode?.kind === "create") {
      setSlug("");
      setDescription("");
      setBody("");
    }
    if (mode?.kind === "edit" && existing.data?.raw) {
      // Full file round-trip (frontmatter included) — the server enforces
      // slug stability on save.
      setBody(existing.data.raw);
    }
  }, [mode, existing.data?.raw]);

  const create = trpc.nimitsJarvis.createSkill.useMutation();
  const saveBody = trpc.nimitsJarvis.updateSkillBody.useMutation();

  const pending = create.isPending || saveBody.isPending;

  const submit = async () => {
    setError(null);
    try {
      if (mode?.kind === "create") {
        if (!/^[a-z0-9-]+$/.test(slug)) {
          setError("Slug must be lowercase [a-z0-9-].");
          return;
        }
        if (!description.trim()) {
          setError("Description is required — write it as a trigger condition.");
          return;
        }
        await create.mutateAsync({ slug, description: description.trim() });
      } else if (mode?.kind === "edit") {
        await saveBody.mutateAsync({ slug: mode.slug, body });
      }
      await utils.nimitsJarvis.listSkills.invalidate();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    }
  };

  return (
    <Dialog open={mode !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {mode?.kind === "create" ? "Create new skill" : `Edit ${mode?.kind === "edit" ? mode.slug : ""}`}
          </DialogTitle>
          <DialogDescription>
            {mode?.kind === "create"
              ? "Scaffolds a skill directory. It lands trusted — you authored it, which is the review."
              : "Frontmatter name must keep matching the slug; renames are rejected."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {mode?.kind === "create" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="skill-slug">Slug</Label>
                <Input
                  id="skill-slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="screenplay-writer"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="skill-desc">
                  Description — write as a trigger condition
                </Label>
                <Textarea
                  id="skill-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Use when the user wants a screenplay, script, or shot list."
                  rows={2}
                />
                <p className="text-[11px] text-muted-foreground">
                  Weak: “Screenplay writing helper”. Strong: “Use when the user
                  wants…”. The index shows only this line before the model decides.
                </p>
              </div>
            </>
          )}
          {mode?.kind === "edit" && (
            <div className="space-y-1.5">
              <Label htmlFor="skill-body">SKILL.md body (instructions)</Label>
              {existing.isLoading ? (
                <p className="text-[12px] text-muted-foreground">Loading…</p>
              ) : (
                <Textarea
                  id="skill-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={16}
                  className="font-mono text-[12px]"
                />
              )}
            </div>
          )}
          {error && <p className="text-[13px] text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending ? "Saving…" : mode?.kind === "create" ? "Create skill" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
