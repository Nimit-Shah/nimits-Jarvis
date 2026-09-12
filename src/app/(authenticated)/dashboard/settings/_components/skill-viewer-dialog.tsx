"use client";

import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Skeleton } from "~/components/ui/skeleton";
import { trpc } from "~/clients/trpc";

interface Finding {
  rule: string;
  detail: string;
}

/**
 * Read-only instruction viewer (§6.3 overflow → View). Always shows the
 * §5.3 scan findings so a skill promoted later still displays what was found.
 */
export function SkillViewerDialog({
  slug,
  onClose,
  onEdit,
  canEdit,
}: {
  slug: string | null;
  onClose: () => void;
  onEdit: () => void;
  canEdit: boolean;
}) {
  const detail = trpc.nimitsJarvis.getSkill.useQuery(
    { slug: slug ?? "" },
    { enabled: slug !== null },
  );
  const findings = (detail.data?.skill.scanFindings as unknown as Finding[] | null) ?? [];
  const toolsRequired = (detail.data?.skill.toolsRequired as unknown as string[]) ?? [];

  return (
    <Dialog open={slug !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-[14px]">{slug}</DialogTitle>
          <DialogDescription>{detail.data?.skill.description}</DialogDescription>
        </DialogHeader>
        {detail.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}
        {detail.data && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
              <span>
                Trust: <strong className="text-foreground">{detail.data.skill.trustTier}</strong>
              </span>
              <span>
                Origin: <strong className="text-foreground">{detail.data.skill.origin}</strong>
              </span>
              {detail.data.skill.version && (
                <span>
                  Version: <strong className="text-foreground">{detail.data.skill.version}</strong>
                </span>
              )}
              <span>
                State: <strong className="text-foreground">{detail.data.skill.stateScope}</strong>
              </span>
            </div>
            {toolsRequired.length > 0 && (
              <div className="text-[12px]">
                <span className="text-muted-foreground">Declared tools (cap): </span>
                <span className="font-mono">{toolsRequired.join(", ")}</span>
              </div>
            )}
            {findings.length > 0 && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="size-3.5" />
                  Scan findings ({findings.length})
                </div>
                <ul className="space-y-1">
                  {findings.map((f, i) => (
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
            )}
            {(detail.data?.audits?.length ?? 0) > 0 && (
              <div className="rounded-md border border-border/60 p-3">
                <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">
                  Third-party audits (informational — enforcement stays with the scan above)
                </div>
                <ul className="space-y-1">
                  {(detail.data?.audits ?? []).map((a, i) => (
                    <li key={i} className="text-[12px] text-muted-foreground">
                      <span className="font-medium text-foreground">{a.provider}</span>
                      {" — "}
                      {a.status}
                      {a.riskLevel ? ` (${a.riskLevel})` : ""}
                      {a.summary ? `: ${a.summary}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <div className="mb-1 text-[12px] font-medium text-muted-foreground">
                Instructions
              </div>
              {detail.data.loadError ? (
                <p className="text-[13px] text-destructive">
                  Could not load SKILL.md: {detail.data.loadError}
                </p>
              ) : (
                <pre className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
                  {detail.data.instructions}
                </pre>
              )}
            </div>
            {canEdit && (
              <button
                onClick={onEdit}
                className="text-[13px] font-medium text-primary hover:underline"
              >
                Edit this skill
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
