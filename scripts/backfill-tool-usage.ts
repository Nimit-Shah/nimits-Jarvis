/**
 * Backfill ToolUsage from existing message history (TOKEN_EFFICIENCY.md §5.1)
 * and auto-propose a per-instance Composio tool allowlist (§5.2).
 *
 * Idempotent: upserts cumulative counters, never resets existing rows.
 * Only touches instance.composioToolAllowlist when it is currently null/empty
 * (operator edits are never clobbered).
 *
 * Run: pnpm exec tsx scripts/backfill-tool-usage.ts
 */
import "dotenv/config";
import { db } from "~/server/clients/db";

const PAGE = 500;

/** Infra/discovery/search tools: never proposed for the allowlist. */
const EXCLUDED_FROM_PROPOSAL = new Set([
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_WAIT_FOR_CONNECTIONS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_REMOTE_WORKBENCH",
  "COMPOSIO_REMOTE_BASH_TOOL",
  // Custom tools are always present regardless of the allowlist.
  "fs_list",
  "fs_read",
  "fs_find",
  "fs_edit",
  "fs_write",
  "fs_delete",
  "fs_mkdir",
  "fs_move",
  "memory_save",
  "memory_search",
  "schedule",
  "read_tool_result",
]);

/** Search/fetch family: biggest tool results in the measured payloads; the
 *  allowlist's purpose is a narrow ACTION toolset, so they are never proposed
 *  (an operator can still add them explicitly in Settings). */
const EXCLUDED_PATTERNS = [
  /^SEARCH_/,
  /^FETCH_/,
  /^COMPOSIO_SEARCH_/,
  /^mcp__/,
];

interface Agg {
  calls: number;
  successes: number;
  lastUsedAt: Date;
}

// instanceId -> toolName -> agg
const aggByInstance = new Map<string, Map<string, Agg>>();

function bump(
  instanceId: string,
  toolName: string,
  at: Date,
  success: boolean,
) {
  let perInstance = aggByInstance.get(instanceId);
  if (!perInstance) {
    perInstance = new Map();
    aggByInstance.set(instanceId, perInstance);
  }
  const cur = perInstance.get(toolName) ?? {
    calls: 0,
    successes: 0,
    lastUsedAt: at,
  };
  cur.calls++;
  if (success) cur.successes++;
  if (at > cur.lastUsedAt) cur.lastUsedAt = at;
  perInstance.set(toolName, cur);
}

/** True when the NEXT assistant row (same chat) contains no tool calls —
 *  i.e. the model moved on with prose instead of retrying/falling back. */
function markOutcomes(
  rows: Array<{
    instanceId: string;
    chatId: string;
    id: string;
    createdAt: Date;
    role: string;
    toolNames: string[];
  }>,
) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.role !== "assistant" || row.toolNames.length === 0) continue;
    const next = rows[i + 1];
    const success =
      !next || next.role !== "assistant" || next.toolNames.length === 0;
    for (const name of row.toolNames) {
      bump(row.instanceId, name, row.createdAt, success);
    }
  }
}

async function main() {
  let lastId: string | undefined;
  let total = 0;

  for (;;) {
    const batch = await db.message.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
      orderBy: { id: "asc" },
      take: PAGE,
      select: {
        id: true,
        instanceId: true,
        chatId: true,
        createdAt: true,
        role: true,
        content: true,
      },
    });
    if (batch.length === 0) break;

    const rows = batch.map((m) => {
      const parts = Array.isArray(m.content) ? m.content : [];
      const toolNames: string[] = [];
      for (const p of parts) {
        if (
          p &&
          typeof p === "object" &&
          (p as Record<string, unknown>).type === "dynamic-tool"
        ) {
          const part = p as Record<string, unknown>;
          const name = part.toolName;
          if (typeof name === "string" && name) toolNames.push(name);
          // Real Composio action tools live as tool_slug inside
          // MULTI_EXECUTE (and occasionally as direct calls) — record them
          // without the COMPOSIO_ prefix so slugs and prefixed names
          // normalize identically for the allowlist.
          if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
            const input = part.input as Record<string, unknown> | undefined;
            const tools = Array.isArray(input?.tools) ? input.tools : [];
            for (const t of tools as Array<Record<string, unknown>>) {
              const slug = t?.tool_slug;
              if (typeof slug === "string" && slug) {
                toolNames.push(slug.replace(/^COMPOSIO_/, ""));
              }
            }
          }
        }
      }
      return {
        instanceId: m.instanceId,
        chatId: m.chatId ?? "",
        id: m.id,
        createdAt: m.createdAt,
        role: m.role,
        toolNames,
      };
    });
    markOutcomes(rows);
    lastId = batch[batch.length - 1]!.id;
    total += rows.length;
    if (batch.length < PAGE) break;
  }

  console.log(`scanned ${total} messages`);

  let upserted = 0;
  for (const [instanceId, perTool] of aggByInstance) {
    for (const [toolName, agg] of perTool) {
      await db.toolUsage.upsert({
        where: { instanceId_toolName: { instanceId, toolName } },
        create: {
          instanceId,
          toolName,
          calls: agg.calls,
          successes: agg.successes,
          lastUsedAt: agg.lastUsedAt,
        },
        update: {
          calls: { increment: agg.calls },
          successes: { increment: agg.successes },
          lastUsedAt: agg.lastUsedAt,
        },
      });
      upserted++;
    }
  }
  console.log(`upserted ${upserted} ToolUsage rows`);

  // ── §5.2 propose allowlists (only when instance has none) ──
  for (const [instanceId, perTool] of aggByInstance) {
    const instance = await db.composioClawInstance.findUnique({
      where: { id: instanceId },
      select: { composioToolAllowlist: true },
    });
    const existing =
      instance && Array.isArray(instance.composioToolAllowlist)
        ? instance.composioToolAllowlist
        : null;
    if (existing && existing.length > 0) continue; // operator already configured

    const ranked = [...perTool.entries()]
      // Only Composio action slugs belong in the allowlist — custom (fs_*/memory/schedule)
      // and MCP tools are always present regardless; exclude infra/discovery/search.
      .filter(([name]) => !EXCLUDED_FROM_PROPOSAL.has(name))
      .filter(([name]) => !EXCLUDED_PATTERNS.some((re) => re.test(name)))
      .sort(
        (a, b) =>
          b[1].calls - a[1].calls ||
          b[1].successes / Math.max(1, b[1].calls) -
            a[1].successes / Math.max(1, a[1].calls),
      )
      .slice(0, 10)
      .map(([name]) => name.replace(/^COMPOSIO_/, ""));

    if (ranked.length === 0) continue;
    await db.composioClawInstance.update({
      where: { id: instanceId },
      data: { composioToolAllowlist: ranked },
    });
    console.log(
      `instance ${instanceId}: proposed allowlist [${ranked.join(", ")}]`,
    );
  }
}

void main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
