import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import manifest from "~/server/lib/skills/discover.json";
import { getDiscoverInput } from "./getDiscover.schema";

interface DiscoverEntry {
  slug: string;
  displayName: string;
  description: string;
  sourceRepo: string;
  subdir?: string;
}

/**
 * Discover tab (§6.3): the static curated manifest plus which slugs this
 * user already installed. Installing reuses importSkill — entries land
 * untrusted like any other import.
 */
export const getDiscover = protectedProcedure
  .input(getDiscoverInput)
  .query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const entries = (manifest as { entries: DiscoverEntry[] }).entries;
    const installed = await db.skill.findMany({
      where: { userId, slug: { in: entries.map((e) => e.slug) } },
      select: { slug: true },
    });
    const installedSlugs = new Set(installed.map((r) => r.slug));
    return {
      entries: entries.map((e) => ({ ...e, installed: installedSlugs.has(e.slug) })),
    };
  });
