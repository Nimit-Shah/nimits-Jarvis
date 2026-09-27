import { db } from "~/server/clients/db";
import { browserTargetFor } from "~/server/lib/browser/browser-target";

export type TargetConflict = {
  id: string;
  name: string;
  instanceName: string;
  target: string;
};

/**
 * Dedication guard (write-time half; the daemon's shared-group refusal is
 * the runtime half): find any OTHER playwright row already occupying the
 * candidate's target. Returns the first conflict, or null when the target
 * is free. Pure lookup — the caller decides refusal vs warning.
 */
export async function findTargetConflict(args: {
  browserMode?: string | null;
  url: string;
  cdpEndpoint?: string | null;
  excludeId?: string;
}): Promise<TargetConflict | null> {
  const target = browserTargetFor(args);
  if (!target) return null;
  const rows = await db.mcpServer.findMany({
    where: {
      serverType: "playwright",
      ...(args.excludeId ? { id: { not: args.excludeId } } : {}),
    },
    select: {
      id: true,
      name: true,
      browserMode: true,
      url: true,
      cdpEndpoint: true,
      instance: { select: { name: true } },
    },
  });
  for (const r of rows) {
    if (browserTargetFor(r) === target) {
      return { id: r.id, name: r.name, instanceName: r.instance.name, target };
    }
  }
  return null;
}
