import { z } from "zod";
import { zodSchema, embed } from "ai";
import type { Tool } from "ai";
import { db } from "~/server/clients/db";
import {
  memorySearchSchema,
  type MemorySearchInput,
} from "./memory-search.schema";
import { ollamaProvider } from "~/server/clients/ollama";
import { env } from "~/env";

const memorySearchResultRow = z.object({
  id: z.string(),
  content: z.string(),
  similarity: z.number(),
});

const memoryContextRow = z.object({
  content: z.string(),
  similarity: z.number(),
});

const mnemosyneRecallResult = z.object({
  found: z.boolean(),
  memories: z.array(
    z.object({
      content: z.string(),
      importance: z.number().optional(),
      score: z.number().optional(),
    }),
  ),
});

/**
 * Query Mnemosyne sidecar for hybrid-search results.
 * Returns null if the sidecar is unavailable or times out (triggers fallback).
 */
async function queryMnemosyne(
  query: string,
  topK: number,
  instanceId: string,
): Promise<Array<{ content: string; relevance: number }> | null> {
  try {
    const res = await fetch(`${env.MNEMOSYNE_URL}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, top_k: topK, instanceId }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = mnemosyneRecallResult.parse(await res.json());
    if (!data.found) return null;
    return data.memories.map((m) => ({
      content: m.content,
      relevance: Math.round((m.score ?? m.importance ?? 0.5) * 100) / 100,
    }));
  } catch {
    // Sidecar offline or timed out → caller falls back to pgvector.
    return null;
  }
}

/**
 * pgvector fallback: cosine-similarity search over composio_claw_memory.
 */
async function queryPgVector(
  instanceId: string,
  query: string,
  limit: number,
): Promise<Array<{ content: string; relevance: number }>> {
  const { embedding: queryEmbedding } = await embed({
    model: ollamaProvider.embedding("qllama/bge-small-en-v1.5"),
    value: query,
  });
  const embeddingString = `[${queryEmbedding.join(",")}]`;

  const results = z.array(memorySearchResultRow).parse(
    await db.$queryRaw`
      SELECT id, content, 1 - (embedding <=> ${embeddingString}::vector) AS similarity
      FROM composio_claw_memory
      WHERE "instanceId" = ${instanceId}
      ORDER BY embedding <=> ${embeddingString}::vector
      LIMIT ${limit}
    `,
  );

  return results
    .filter((r) => r.similarity > 0.5)
    .map((r) => ({
      content: r.content,
      relevance: Math.round(r.similarity * 100) / 100,
    }));
}

export function createMemorySearchTool(instanceId: string): Tool<
  MemorySearchInput,
  {
    found: boolean;
    memories: Array<{ content: string; relevance: number }>;
  }
> {
  return {
    description: "Search your memory for relevant past information",
    inputSchema: zodSchema(memorySearchSchema),
    execute: async ({ query, maxResults }) => {
      const limit = maxResults ?? 5;

      // ── Primary: Mnemosyne hybrid search ─────────────────────────────────
      const mnResults = await queryMnemosyne(query, limit, instanceId);
      if (mnResults !== null) {
        return { found: mnResults.length > 0, memories: mnResults };
      }

      // ── Fallback: pgvector cosine similarity ──────────────────────────────
      const pgResults = await queryPgVector(instanceId, query, limit);
      return { found: pgResults.length > 0, memories: pgResults };
    },
  };
}

/**
 * Context injection helper — called before every LLM turn to pre-load
 * relevant memories into the system context. Attempts Mnemosyne first,
 * falls back to pgvector.
 */
export async function searchMemoriesForContext(
  instanceId: string,
  query: string,
  maxResults = 5,
): Promise<string[]> {
  try {
    // ── Primary: Mnemosyne ────────────────────────────────────────────────
    const mnResults = await queryMnemosyne(query, maxResults, instanceId);
    if (mnResults !== null) {
      return mnResults.map((r) => r.content);
    }

    // ── Fallback: pgvector ────────────────────────────────────────────────
    const { embedding: queryEmbedding } = await embed({
      model: ollamaProvider.embedding("qllama/bge-small-en-v1.5"),
      value: query,
    });
    const embeddingString = `[${queryEmbedding.join(",")}]`;

    const results = z.array(memoryContextRow).parse(
      await db.$queryRaw`
        SELECT content, 1 - (embedding <=> ${embeddingString}::vector) AS similarity
        FROM composio_claw_memory
        WHERE "instanceId" = ${instanceId}
        ORDER BY embedding <=> ${embeddingString}::vector
        LIMIT ${maxResults}
      `,
    );

    return results.filter((r) => r.similarity > 0.5).map((r) => r.content);
  } catch {
    return [];
  }
}

/**
 * Cheap, free heuristic to decide if the prep-time memory lookup is worth
 * running at all. Most conversational follow-ups don't reference past context,
 * so we skip the (network) Mnemosyne/embedding call entirely unless the prompt
 * contains an explicit backward reference or a distinctive entity/topic token.
 *
 * This is intentionally conservative: when it says "skip", we simply don't
 * pre-load memories — the agent can still call the `memory_search` tool itself
 * if a follow-up needs it. When it says "lookup", we fall through to the real
 * semantic search. The helper only gates the *prep-time* call, never the tool.
 */
const BACKWARD_REFERENCE_RE =
  /(?:\b(?:earlier|before|later|previously|remember|recall|last time|we discussed|we said|we decided|the other day|yesterday|that thing|what about)\b|(?:do you (?:still |)remember|you said|i mentioned|as we discussed))/i;

export function shouldLookupMemoriesForContext(prompt: string): boolean {
  if (!prompt || prompt.trim().length < 2) return false;
  // Explicit backward reference ("earlier", "we discussed", "last time", ...).
  // Conservative by design: default is to SKIP the prep-time lookup (the latency
  // win); the agent can still call the `memory_search` tool when needed.
  return BACKWARD_REFERENCE_RE.test(prompt);
}
