"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { trpc } from "~/clients/trpc";
import { cn } from "~/lib/utils";

const TIERS = [
  {
    id: "untrusted",
    label: "Untrusted",
    grants: "Hidden from the index. Usable only when pinned, with read-only tools.",
  },
  {
    id: "verified",
    label: "Verified",
    grants: "Listed as pin-only. Usable only when pinned, capped to its declared tools.",
  },
  {
    id: "trusted",
    label: "Trusted",
    grants: "Auto-selected by the model from the index, with the full ToolSet.",
  },
] as const;

/**
 * Trust-tier promotion with a confirmation naming what the tier grants.
 * The server logs the change — promotion is an explicit, recorded action.
 */
export function SkillTrustDialog({
  slug,
  current,
  onClose,
  onSaved,
}: {
  slug: string | null;
  current: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const utils = trpc.useUtils();
  const [tier, setTier] = useState<string>(current);
  const [error, setError] = useState<string | null>(null);
  const update = trpc.nimitsJarvis.updateSkill.useMutation();

  const selected = TIERS.find((t) => t.id === tier);

  const submit = async () => {
    if (!slug || tier === current) {
      onClose();
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({
        slug,
        trustTier: tier as "untrusted" | "verified" | "trusted",
      });
      await utils.nimitsJarvis.listSkills.invalidate();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Promotion failed.");
    }
  };

  return (
    <Dialog open={slug !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Set trust tier — {slug}</DialogTitle>
          <DialogDescription>
            Currently <strong>{current}</strong>. A hostile skill would declare
            itself trusted, so the tier always comes from you — never from the skill file.
          </DialogDescription>
        </DialogHeader>
        <RadioGroup value={tier} onValueChange={setTier} className="space-y-2">
          {TIERS.map((t) => (
            <Label
              key={t.id}
              htmlFor={`tier-${t.id}`}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-md border p-3",
                tier === t.id ? "border-primary/60 bg-accent/40" : "border-border/60",
              )}
            >
              <RadioGroupItem id={`tier-${t.id}`} value={t.id} className="mt-0.5" />
              <span>
                <span className="block text-[13px] font-medium">{t.label}</span>
                <span className="block text-[12px] text-muted-foreground">{t.grants}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>
        {selected && tier !== current && (
          <p className="text-[12px] text-muted-foreground">
            Confirm: <strong className="text-foreground">{slug}</strong> becomes{" "}
            <strong className="text-foreground">{selected.label}</strong> — {selected.grants}
          </p>
        )}
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Confirm"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
