import { db } from "~/server/clients/db";
import { materializeSkill } from "./materialize";

export interface ResolvedPin {
  skillId: string;
  slug: string;
  displayName: string;
  trustTier: string;
  stateScope: string;
  toolsRequired: string[];
  instructions: string | null;
  loadError: string | null;
  references: string[];
  state: unknown;
}

/**
 * Pin validation + materialization (§3.3/§5.1). Ownership is enforced by the
 * query (userId + slug + enabled); unknown, unowned, disabled, or
 * out-of-instance slugs are dropped silently so a stale client cannot probe.
 * source !== "web" resolves to no pins — cron/telegram cannot pin, so only
 * trusted skills are reachable there by construction.
 */
export async function resolvePinnedSkills(opts: {
  userId: string;
  instanceId: string;
  chatId: string;
  source: string;
  slugs: string[];
}): Promise<{ pins: ResolvedPin[]; loadedSlugs: Set<string> }> {
  const loadedSlugs = new Set<string>();
  const pins: ResolvedPin[] = [];
  if (opts.source !== "web") return { pins, loadedSlugs };

  const unique = [...new Set(opts.slugs)];
  if (unique.length === 0) return { pins, loadedSlugs };

  const rows = await db.skill.findMany({
    where: { userId: opts.userId, slug: { in: unique }, enabled: true },
    select: {
      id: true,
      slug: true,
      displayName: true,
      trustTier: true,
      toolsRequired: true,
      dirPath: true,
      stateScope: true,
      instanceId: true,
    },
  });

  for (const slug of unique) {
    const row = rows.find((r) => r.slug === slug);
    if (!row) continue;
    if (row.instanceId && row.instanceId !== opts.instanceId) continue;
    loadedSlugs.add(row.slug);
    const m = await materializeSkill(row, {
      chatId: opts.chatId,
      instanceId: opts.instanceId,
    });
    if (!m.ok) {
      pins.push({
        skillId: row.id,
        slug: row.slug,
        displayName: row.displayName,
        trustTier: row.trustTier,
        stateScope: row.stateScope,
        toolsRequired: row.toolsRequired,
        instructions: null,
        loadError: m.reason,
        references: [],
        state: null,
      });
      continue;
    }
    pins.push({
      skillId: row.id,
      slug: row.slug,
      displayName: row.displayName,
      trustTier: row.trustTier,
      stateScope: row.stateScope,
      toolsRequired: m.materialized.toolsRequired,
      instructions: m.materialized.instructions,
      loadError: null,
      references: m.materialized.references,
      state: m.materialized.state,
    });
  }
  return { pins, loadedSlugs };
}
