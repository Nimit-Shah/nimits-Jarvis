import { z } from "zod";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { getMemoriesInput, memoryRow } from "./getMemories.schema";
import { env } from "~/env";
import { getInstanceForUser } from "./utils";

const profileItem = z.object({
  key: z.string(),
  category: z.string(),
  label: z.string(),
  value: z.string(),
  importance: z.number(),
  updated_at: z.string(),
});

const mnemosyneProfileResponse = z.object({
  profile: z.array(profileItem),
  grouped: z.record(z.string(), z.array(profileItem)),
  total: z.number(),
});

/**
 * Fetch structured AI Profile from Mnemosyne sidecar.
 * Returns null if sidecar is offline — callers handle gracefully.
 */
async function fetchMnemosyneProfile(instanceId: string): Promise<z.infer<typeof mnemosyneProfileResponse> | null> {
  try {
    const res = await fetch(`${env.MNEMOSYNE_URL}/profile?instance_id=${encodeURIComponent(instanceId)}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return mnemosyneProfileResponse.parse(await res.json());
  } catch {
    return null;
  }
}

export const getMemories = protectedProcedure
  .input(getMemoriesInput)
  .query(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;

    // Resolve instance with ownership check
    const instance = await getInstanceForUser(userId, input.instanceId);

    const cursorDate = input.cursor ? new Date(input.cursor) : undefined;

    const rows = await db.memory.findMany({
      where: {
        instanceId: instance.id,
        ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}),
      },
      select: { id: true, content: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: input.limit + 1,
    });

    const hasNextPage = rows.length > input.limit;
    const sliced = hasNextPage ? rows.slice(0, input.limit) : rows;
    const items = z.array(memoryRow).parse(sliced);
    const nextCursor =
      hasNextPage && sliced.length > 0
        ? sliced[sliced.length - 1]!.createdAt.toISOString()
        : undefined;

    // Fetch AI Profile from Mnemosyne (non-blocking — returns null if offline)
    const aiProfile = await fetchMnemosyneProfile(instance.id);

    return {
      items,
      nextCursor,
      aiProfile,
    };
  });
