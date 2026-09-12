import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { db } from "~/server/clients/db";
import { getSkillDir, getSkillsRoot } from "./constants";
import { parseSkillFile } from "./parse";
import { scanFindingsJson, scanSkillBody } from "./scan";

export interface ReconcileSummary {
  root: string;
  upserted: string[];
  hashUpdated: string[];
  rejected: Array<{ slug: string; reason: string }>;
  disabled: string[];
}

/**
 * Filesystem-to-database reconciliation. The filesystem is the source of
 * record for content; Postgres is the index of record for discovery.
 *
 * - Hash each SKILL.md; update rows whose contentHash changed.
 * - Mark rows whose directory disappeared as enabled:false (never delete —
 *   useCount history survives a re-install). Re-enable is an explicit UI
 *   action, so a deliberate disable is never undone by a reinstall.
 * - Never touch trustTier/enabled on rows whose directory is present.
 */
export async function reconcileSkillsForUser(
  userId: string,
  root: string = getSkillsRoot(),
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    root,
    upserted: [],
    hashUpdated: [],
    rejected: [],
    disabled: [],
  };

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return summary;
    throw err;
  }

  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const parsed = await parseSkillFile(join(getSkillDir(root, entry), "SKILL.md"));
    if (!parsed.ok) {
      // A directory whose SKILL.md is missing/unparseable is not a skill.
      // Only report it when the dirname itself looks like a slug.
      if (/^[a-z0-9-]+$/.test(entry)) {
        summary.rejected.push({ slug: entry, reason: parsed.reason });
      }
      continue;
    }
    const s = parsed.skill;
    seen.add(s.slug);
    const existing = await db.skill.findUnique({
      where: { userId_slug: { userId, slug: s.slug } },
      select: { id: true, contentHash: true },
    });
    if (!existing) {
      await db.skill.create({
        data: {
          userId,
          slug: s.slug,
          displayName: s.displayName,
          description: s.description,
          origin: "authored",
          dirPath: getSkillDir(root, s.slug),
          contentHash: s.contentHash,
          version: s.version,
          toolsRequired: s.toolsRequired,
          stateScope: s.stateScope,
          // trustTier defaults to untrusted and is never written here —
          // tier is assigned by the installer, never read from frontmatter.
          scanFindings: scanFindingsJson(scanSkillBody(s.raw, s)),
        },
      });
      summary.upserted.push(s.slug);
    } else if (existing.contentHash !== s.contentHash) {
      await db.skill.update({
        where: { id: existing.id },
        data: {
          displayName: s.displayName,
          description: s.description,
          dirPath: getSkillDir(root, s.slug),
          contentHash: s.contentHash,
          version: s.version,
          toolsRequired: s.toolsRequired,
          stateScope: s.stateScope,
          scanFindings: scanFindingsJson(scanSkillBody(s.raw, s)),
        },
      });
      summary.hashUpdated.push(s.slug);
    }
  }

  const rows = await db.skill.findMany({
    where: { userId, enabled: true },
    select: { id: true, slug: true },
  });
  for (const row of rows) {
    if (!seen.has(row.slug)) {
      await db.skill.update({
        where: { id: row.id },
        data: { enabled: false },
      });
      summary.disabled.push(row.slug);
    }
  }

  return summary;
}
