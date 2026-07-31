import { zodSchema, embed } from "ai";
import type { Tool } from "ai";
import { db } from "~/server/clients/db";
import { memorySaveSchema, type MemorySaveInput } from "./memory-save.schema";
import { ollamaProvider } from "~/server/clients/ollama";
import { env } from "~/env";

/**
 * Fire-and-forget POST to Mnemosyne sidecar.
 * Errors are swallowed so they never block the agent's response stream.
 * The pgvector insert above is the primary durable store; Mnemosyne is the
 * primary *search* layer with hybrid FTS5 + vector scoring.
 */
async function sendToMnemosyne(content: string, instanceId: string): Promise<void> {
  try {
    await fetch(`${env.MNEMOSYNE_URL}/remember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: content, importance: 0.8, source: "conversation", instanceId }),
      signal: AbortSignal.timeout(3000), // 3s max — non-blocking
    });
  } catch {
    // Intentionally silent — Mnemosyne is a bonus layer, not the primary store.
    // pgvector already persisted the memory above.
  }
}

export function createMemorySaveTool(
  instanceId: string,
): Tool<MemorySaveInput, { saved: boolean; content: string }> {
  return {
    description: "Save an important fact or observation for future reference",
    inputSchema: zodSchema(memorySaveSchema),
    execute: async ({ content }) => {
      // ── Primary store: pgvector ───────────────────────────────────────────
      const { embedding } = await embed({
        model: ollamaProvider.embedding("qllama/bge-small-en-v1.5"),
        value: content,
      });
      const embeddingString = `[${embedding.join(",")}]`;
      const id = crypto.randomUUID();

      await db.$queryRaw`
        INSERT INTO composio_claw_memory (id, "instanceId", content, embedding, "createdAt")
        VALUES (${id}, ${instanceId}, ${content}, ${embeddingString}::vector, NOW())
      `;

      // ── Secondary store: Mnemosyne (fire-and-forget) ──────────────────────
      // Does NOT block the response — runs after we return from execute().
      void sendToMnemosyne(content, instanceId);

      return { saved: true, content };
    },
  };
}
