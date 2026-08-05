import { generateText, stepCountIs } from "ai";
import { db } from "~/server/clients/db";
import { createCustomTools } from "../tools";
import { serializeMessages } from "./prompts";
import type { ReconstructedMessage } from "../types";
import { getModelProvider, buildLLM, llmTimeoutFor } from "../model-utils";
import { computeSummarizationBudget } from "../context/context-window";
import { PIIVault } from "../pii";

const FLUSH_SYSTEM_PROMPT =
  "Pre-compaction memory flush turn. " +
  "The session is near auto-compaction; capture durable memories now. " +
  "You have access to memory_save and memory_search. " +
  "Save any important context, user preferences, decisions, or ongoing task state that should persist beyond this conversation window. " +
  "If nothing needs saving, respond with <silent/>.";

const FLUSH_USER_PROMPT =
  "Pre-compaction memory flush. " +
  "Store durable memories now using memory_save. " +
  "Focus on: user preferences, key decisions, task progress, important context. " +
  "If nothing to store, reply with <silent/>.";

interface MemoryFlushParams {
  chatId: string;
  instanceId: string;
  anthropicModel: string;
  messages: ReconstructedMessage[];
  compactionCount: number;
  piiVault: PIIVault | null;
}

interface MemoryFlushResult {
  memoriesSaved: number;
}

export async function runMemoryFlush(
  params: MemoryFlushParams,
): Promise<MemoryFlushResult> {
  const { chatId, instanceId, anthropicModel, messages, compactionCount, piiVault } = params;

  try {
    const provider = getModelProvider(anthropicModel);
    const isOllama = provider === "ollama";
    const model = buildLLM(anthropicModel);

    const allCustomTools = createCustomTools(instanceId);
    const memoryTools = {
      memory_save: allCustomTools.memory_save,
      memory_search: allCustomTools.memory_search,
    };

    const contextSummary = serializeMessages(messages);
    const budget = computeSummarizationBudget(anthropicModel);
    const cappedContext =
      contextSummary.length > budget
        ? `... [earlier context omitted] ...\n${contextSummary.slice(-budget)}`
        : contextSummary;

    // Redact PII before sending to external LLMs. If the main agent's
    // PIIVault was passed in, reuse its registrations (which include
    // structured-extraction PII from tool results). Otherwise create a
    // fresh vault which only does regex scanning.
    const vault =
      !isOllama
        ? piiVault ?? new PIIVault()
        : null;
    const safeContext = vault ? await vault.redact(cappedContext) : cappedContext;

    const flushPrompt = `Here is the recent conversation context:\n\n${safeContext}\n\n${FLUSH_USER_PROMPT}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), llmTimeoutFor(flushPrompt));

    let result;
    try {
      result = await generateText({
        model,
        system: FLUSH_SYSTEM_PROMPT,
        messages: [{ role: "user" as const, content: flushPrompt }],
        tools: memoryTools,
        stopWhen: stepCountIs(3),
        maxOutputTokens: 1_000,
        abortSignal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    let memoriesSaved = 0;
    for (const step of result.steps) {
      for (const toolCall of step.toolCalls) {
        if (toolCall.toolName === "memory_save") {
          memoriesSaved++;
        }
      }
    }

    // Atomically claim this flush cycle AFTER the LLM call succeeds.
    // If the LLM fails, the counter stays unchanged and the next cycle
    // will retry without permanent data loss.
    const claim = await db.chat.updateMany({
      where: {
        id: chatId,
        memoryFlushCount: { lte: compactionCount },
      },
      data: { memoryFlushCount: compactionCount + 1 },
    });
    if (claim.count === 0) {
      return { memoriesSaved: 0 };
    }

    // Persist the flush turn for transcript history.
    await db.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          instanceId,
          chatId,
          role: "user",
          content: [{ type: "text", text: FLUSH_USER_PROMPT }],
          source: "web",
          messageType: "memory_flush",
        },
      });

      await tx.message.create({
        data: {
          instanceId,
          chatId,
          role: "assistant",
          content: [{ type: "text", text: result.text || "<silent/>" }],
          source: "web",
          messageType: "memory_flush",
        },
      });
    });

    return { memoriesSaved };
  } catch {
    return { memoriesSaved: 0 };
  }
}
