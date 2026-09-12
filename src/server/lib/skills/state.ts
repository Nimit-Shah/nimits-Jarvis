import type { Prisma } from "~/generated/prisma/client";
import { db } from "~/server/clients/db";

const MAX_STATE_BYTES = 8_192;

export interface SkillStateUpdate {
  slug: string;
  data: unknown;
}

/**
 * In-band state protocol (Phase 6). load_skill is the only skills-related
 * tool, so state writes cannot be a tool — the model ends a turn with:
 *
 *   ```skill-state <slug>
 *   {"key": "value"}
 *   ```
 *
 * The latest block per slug per turn wins. Blocks must be JSON objects under
 * 8KB; anything else is ignored (never throws — onFinish must not fail).
 */
export function stateProtocolText(slug: string): string {
  return `To persist state across turns, end a turn with a fenced block:\n\`\`\`skill-state ${slug}\n{"key": "value"}\n\`\`\`\nKeep it a JSON object under 8KB. The latest block per turn wins.`;
}

const BLOCK_RE = /^```skill-state\s+([a-z0-9-]+)\s*\n([\s\S]*?)```/gm;

export function extractSkillStateUpdates(text: string): SkillStateUpdate[] {
  const latest = new Map<string, unknown>();
  for (const m of text.matchAll(BLOCK_RE)) {
    const slug = m[1]!;
    const raw = (m[2] ?? "").trim();
    if (!raw || Buffer.byteLength(raw, "utf-8") > MAX_STATE_BYTES) continue;
    try {
      const data: unknown = JSON.parse(raw);
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        continue;
      }
      latest.set(slug, data);
    } catch {
      continue;
    }
  }
  return [...latest.entries()].map(([slug, data]) => ({ slug, data }));
}

/**
 * Upsert SkillState with sentinel scope keys (session → chatId, persistent →
 * instanceId, unused half ""). Skill state is structured procedure data —
 * never routed through the pgvector memory system.
 */
export async function saveSkillState(opts: {
  skillId: string;
  stateScope: string;
  chatId: string;
  instanceId: string;
  data: unknown;
}): Promise<void> {
  if (opts.stateScope !== "session" && opts.stateScope !== "persistent") return;
  const normalized = JSON.parse(JSON.stringify(opts.data)) as Prisma.InputJsonValue;
  await db.skillState.upsert({
    where: {
      skillId_chatId_instanceId: {
        skillId: opts.skillId,
        chatId: opts.stateScope === "session" ? opts.chatId : "",
        instanceId: opts.stateScope === "persistent" ? opts.instanceId : "",
      },
    },
    create: {
      skillId: opts.skillId,
      chatId: opts.stateScope === "session" ? opts.chatId : "",
      instanceId: opts.stateScope === "persistent" ? opts.instanceId : "",
      data: normalized,
    },
    update: { data: normalized },
  });
}
