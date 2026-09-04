import { generateText, stepCountIs, type Tool } from "ai";
import { db } from "~/server/clients/db";
import { createCustomTools } from "../tools";
import { serializeMessages } from "./prompts";
import type { ReconstructedMessage } from "../types";
import { getModelProvider, buildLLM, llmTimeoutFor } from "../model-utils";
import { computeSummarizationBudget } from "../context/context-window";
import { PIIVault, deepStripResidualTokens, stripResidualTokens } from "../pii";

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

/**
 * Restores any PII tokens in a tool's input back to real values before the
 * tool runs. The flush turn's memory_save / memory_search tools are passed to
 * generateText() DIRECTLY — unlike the main agent's tools, they do NOT go
 * through wrapToolExecutors(). Without this restore, a `[CLAW_*]` token the
 * flush LLM saw in the redacted context would be persisted to memory verbatim
 * (memory_save) or queried verbatim (memory_search). Those tokens are per-request
 * and their mapping is never persisted, so restoring now is the only chance to
 * keep the durable store at real values.
 */
function wrapFlushTool<I, O>(tool: Tool<I, O>, vault: PIIVault | null): Tool<I, O> {
  const originalExecute = tool.execute;
  if (!originalExecute) return tool;
  const wrapped = {
    ...tool,
    execute: async (...args: Parameters<typeof originalExecute>): Promise<O> => {
      const [input] = args;
      // After restore, deep-strip any residual (orphan) token the vault could
      // not resolve so it is never persisted by memory_save / Mnemosyne.
      const restoredInput = deepStripResidualTokens(
        vault ? vault.restoreDeep(input) : input,
      ) as I;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return originalExecute(restoredInput, ...(args.slice(1) as [any])) as Promise<O>;
    },
  };
  return wrapped as unknown as Tool<I, O>;
}

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

    // Redact PII before sending to external LLMs. If the main agent's
    // PIIVault was passed in, reuse its registrations (which include
    // structured-extraction PII from tool results). Otherwise create a
    // fresh vault which only does regex scanning. Declared before the tools
    // so wrapFlushTool can restore their inputs with it.
    const vault =
      !isOllama
        ? piiVault ?? new PIIVault()
        : null;

    // Memory flush never exposes fs tools (unattended path, read-only ceiling)
    const allCustomTools = createCustomTools(instanceId, chatId, "UTC", {
      fsReadEnabled: false,
      fsMode: "read-only",
      fsRoot: null,
      instanceId,
      chatId,
      changeBudget: { remaining: 0 },
    });
    // Wrap both memory tools so any PII token in their inputs is restored to a
    // real value before persistence/query (see wrapFlushTool above).
    const memoryTools = {
      memory_save: wrapFlushTool(allCustomTools.memory_save, vault),
      memory_search: wrapFlushTool(allCustomTools.memory_search, vault),
    };

    const contextSummary = serializeMessages(messages);
    const budget = computeSummarizationBudget(anthropicModel);
    const cappedContext =
      contextSummary.length > budget
        ? `... [earlier context omitted] ...\n${contextSummary.slice(-budget)}`
        : contextSummary;

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

    // Restore PII tokens in the flush assistant text before persisting so the
    // transcript stores real values. The flush LLM saw a redacted context and
    // may have echoed `[CLAW_*]` tokens into its reply; the same-request vault
    // can still resolve them here, but once persisted they'd be unrecoverable.
    // Strip any residual (orphan) token restore() cannot resolve so the flush
    // transcript never stores a raw placeholder that would re-leak.
    const flushText = vault
      ? stripResidualTokens(vault.restore(result.text || "<silent/>"))
      : stripResidualTokens(result.text || "<silent/>");

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
          content: [{ type: "text", text: flushText }],
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
