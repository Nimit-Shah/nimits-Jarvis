import { ToolLoopAgent, stepCountIs } from "ai";
import type { ToolSet, SystemModelMessage } from "ai";
import { after } from "next/server";
import { db } from "~/server/clients/db";
import { getOrCreateSessionAndTools } from "~/server/clients/composio";
import { decrypt } from "~/lib/crypto";
import { buildSystemPrompt } from "./system-prompt";
import { ollamaProvider } from "~/server/clients/ollama";
import {
  createCustomTools,
  searchMemoriesForContext,
  shouldLookupMemoriesForContext,
} from "./tools";
import { getContextWindow } from "./context/context-window";
import { pruneContext } from "./context/context-pruning";
import {
  loadContextMessages,
  buildContext,
  toPlainRecordSafe,
  toPrismaJson,
  runPostResponseTasks,
  sanitizeString,
  deepSanitize,
} from "./context/build-context";
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
} from "./context/token-estimation";
import { stripToolResultEchoes } from "./strip-tool-echoes";
import { clearStreamingMessage } from "~/server/clients/redis";
import type { ReconstructedMessage } from "./types";
import { getModelProvider, isAnthropicModel, buildLLM } from "./model-utils";
import { optimizeToolSchemas } from "./tool-optimizer";
import {
  PIIVault,
  PIITransportShield,
  stripResidualTokens,
  deepStripResidualTokens,
} from "./pii";

type MessageSource = "web" | "telegram" | "cron";

/**
 * Wraps every tool's execute function to:
 * 1. Sanitize return values (replace lone Unicode surrogates with U+FFFD).
 * 2. Optionally redact PII in tool results when a PIIVault is active.
 *
 * Composio tool results (e.g. scraped web pages, email bodies) can contain
 * malformed Unicode that produces invalid JSON, and PII that should not
 * reach external LLMs.
 */
function wrapToolExecutors(
  tools: ToolSet,
  vault: PIIVault | null,
  restoreCache: Map<string, unknown>,
): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.execute) {
      wrapped[name] = tool;
      continue;
    }
    const originalExecute = tool.execute;
    wrapped[name] = {
      ...tool,
      execute: async (...args: Parameters<typeof originalExecute>) => {
          // Step 1: Restore PII tokens in tool inputs before sending
          // to Composio. The LLM generated tool args may contain PII tokens
          // like [CLAW_EMAIL_A1B2] that need to be restored to real values.
          // After restore, deep-strip any residual (orphan) token the vault
          // could not resolve — otherwise it would be persisted verbatim by
          // durable tools (memory_save, Mnemosyne) and re-leak forever.
          const [input] = args;
          // The AI SDK passes a toolCallId inside the execution options (args[1]).
          const options = args[1] as { toolCallId?: string } | undefined;
          const tid = options?.toolCallId;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          const restoredInput = deepStripResidualTokens(
            vault ? vault.restoreDeep(input) : input,
          );
          // Cache the restored (real) input ONCE so DB persistence + any UI
          // re-render reads the exact same value the third-party tool saw.
          if (vault && tid) {
            restoreCache.set(tid, restoredInput);
          }

          // Step 2: Call the actual tool with restored (real) values
          let result;
          try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            result = await originalExecute(restoredInput, ...(args.slice(1) as [any]));
          } catch (error) {
            // Step 3: Sanitize error messages — any PII that leaked into
            // the error message (e.g. "Failed to send to john@example.com")
            // must be re-redacted before it reaches the LLM context.
            if (vault && error instanceof Error) {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
              error.message = await vault.redact(error.message);
            }
            throw error;
          }

          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          const sanitized = deepSanitize(result);

          // If a PII vault is active, extract structured PII from known
          // fields (names, emails in JSON) then redact all string values.
          if (vault) {
            vault.registerStructuredPII(sanitized);
            // Cache the REAL (pre-redaction) result once, keyed by tool call id,
            // so DB persistence reads the same value instead of re-restoring the
            // redacted copy.
            if (tid) {
              restoreCache.set(`out:${tid}`, sanitized);
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return await vault.redactToolResult(sanitized);
          }

          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return sanitized;
        },
      };
  }
  return wrapped;
}

/**
 * Redacts a list of reconstructed messages before they are sent to the LLM.
 * Returns a new deep-cloned array with text contents redacted.
 */
async function redactContextMessages(
  messages: ReconstructedMessage[],
  vault: PIIVault,
): Promise<ReconstructedMessage[]> {
  const result: ReconstructedMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({ ...msg, content: await vault.redact(msg.content) });
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        result.push({ ...msg, content: await vault.redact(msg.content) });
      } else {
        const redactedParts = [];
        for (const part of msg.content) {
          if (part.type === "text") {
            redactedParts.push({ ...part, text: await vault.redact(part.text) });
          } else if (part.type === "tool-call") {
            redactedParts.push({
              ...part,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              input: (await vault.redactToolResult(part.input)) as Record<string, unknown>,
            });
          } else if (part.type === "reasoning") {
            redactedParts.push({
              ...part,
              text: await vault.redact(part.text as string),
            });
          } else {
            redactedParts.push(part);
          }
        }
        result.push({ ...msg, content: redactedParts });
      }
    } else if (msg.role === "tool") {
      const redactedParts = [];
      for (const part of msg.content) {
        if (part.type === "tool-result") {
          redactedParts.push({
            ...part,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            output: (await vault.redactToolResult(part.output)) as any,
          });
        } else {
          redactedParts.push(part);
        }
      }
      result.push({ ...msg, content: redactedParts });
    } else {
      result.push(msg);
    }
  }
  return result;
}

interface PrepareAgentRunParams {
  instanceId: string;
  chatId: string;
  userMessage: string;
  source: MessageSource;
  userMessageType?: "hidden";
  isVoice?: boolean;
}

interface PrepareAgentRunResult {
  agent: ToolLoopAgent;
  messages: ReconstructedMessage[];
  /** PII vault for this request. Null if redaction is disabled (local model). */
  piiVault: PIIVault | null;
}

type PrepareResult = { status: "ready"; result: PrepareAgentRunResult };

export async function prepareAgentRun(
  params: PrepareAgentRunParams,
): Promise<PrepareResult> {
  const { instanceId, chatId, userMessage, source, userMessageType, isVoice } = params;
  const t0 = performance.now();
  const mark = (label: string) => {
    console.log(`[agent/prep] ${label}: ${Math.round(performance.now() - t0)}ms`);
  };

  const [instance, chat] = await Promise.all([
    db.composioClawInstance.findUnique({
      where: { id: instanceId },
    }),
    db.chat.findUnique({
      where: { id: chatId },
    }),
  ]);

  if (!instance) {
    throw new Error("Instance not found");
  }
  if (!chat) {
    throw new Error("Chat not found");
  }

  const user = await db.user.findUnique({
    where: { id: instance.userId },
    select: { timezone: true },
  });

  const userTimezone = user?.timezone ?? "UTC";
  mark("db: instance+chat+user");

  const provider = getModelProvider(chat.model);
  const isOllama = provider === "ollama";
  const useAnthropicOptions = isAnthropicModel(chat.model);

  // Create a PII vault for non-local models to redact sensitive data
  // before it reaches the external LLM. Local Ollama models are exempt
  // since data stays on-device. Users can disable via Settings.
  const piiVault =
    !isOllama && instance.piiRedactionEnabled ? new PIIVault() : null;

  // The transport shield is the final network-layer checkpoint.
  // It shares the same vault so tokens are consistent across all layers
  // (tool results, context messages, system prompt, user message).
  const transportShield = piiVault ? new PIITransportShield(piiVault) : null;

  // Only run the (network) prep-time memory lookup when it's plausibly needed.
  // Conservative heuristic: skip for in-flow follow-ups (the agent can still
  // call memory_search itself), which removes a blocking call from the common
  // case and speeds up time-to-first-token.
  const relevantMemories = shouldLookupMemoriesForContext(userMessage)
    ? await searchMemoriesForContext(instanceId, userMessage)
    : [];
  mark("memory search");

  // Redact ONLY the dynamic user-supplied prompt sections (soul/identity/user),
  // so static content (agent title, tool descriptions, protocol, guidelines)
  // is passed through untouched — the agent name & product name must survive.
  // If not PII-redacting (local model / disabled), sections pass through as-is.
  const redactSection = async (section: string | null): Promise<string | null> =>
    section === null || section.trim() === ""
      ? section
      : transportShield
        ? await transportShield.scrubText(section)
        : section;

  const [safeSoul, safeIdentity, safeUser] = await Promise.all([
    redactSection(instance.soulPrompt),
    redactSection(instance.identityPrompt),
    redactSection(instance.userPrompt),
  ]);

  const systemPrompt = sanitizeString(
    buildSystemPrompt({
      soulPrompt: safeSoul,
      identityPrompt: safeIdentity,
      userPrompt: safeUser,
      hasCompactionSummary: !!chat.lastCompactionSummary,
      isOllama,
      piiEnabled: !!piiVault,
      isVoice: isVoice ?? false,
    }),
  );  const dbMessages = await loadContextMessages(
    instanceId,
    chatId,
    chat.lastCompactionAt,
  );
  const aiMessages = buildContext(
    dbMessages,
    chat.lastCompactionSummary,
    userMessage,
    relevantMemories,
    userTimezone,
  );

  const contextWindow = getContextWindow(chat.model);
  const { messages: prunedMessages } = pruneContext(aiMessages, contextWindow);

  // Add cache breakpoint to last history message (before new user message)
  // so the conversation prefix is cached across turns.
  // Only apply Anthropic-specific cacheControl for Anthropic models —
  // non-Anthropic models (OpenAI, DeepSeek, Google) don't
  // understand this option and may reject the request.
  // Only user/assistant messages support cacheControl; tool messages reject it.
  if (useAnthropicOptions && prunedMessages.length >= 2) {
    const lastHistoryIndex = prunedMessages.length - 2;
    const msg = prunedMessages[lastHistoryIndex]!;
    if (msg.role === "user" || msg.role === "assistant") {
      prunedMessages[lastHistoryIndex] = {
        ...msg,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      };
    }
  }

  // Create Composio session and fetch tools BEFORE persisting the user
  // message, so a failed API call doesn't leave an orphaned user message.
  const decryptedApiKey = await (async () => {
    try {
      return instance.composioApiKey
        ? await decrypt(instance.composioApiKey)
        : null;
    } catch {
      throw new Error(
        "Failed to decrypt your Composio API key. The key may be corrupted. " +
        "Try re-entering it in Settings.",
      );
    }
  })();
  // Reuse a cached Composio tool-router session + tool list across turns for
  // this instance. This avoids re-invoking composio.create() + session.tools()
  // (2 network calls) on conversational follow-ups — the biggest pre-first-token
  // latency cost. Connection-status/connect flows keep fresh sessions and call
  // invalidateSession() to refresh this cache.
  const { rawTools: rawComposioTools } = await getOrCreateSessionAndTools(
    instance.id,
    decryptedApiKey,
    { manageConnections: { waitForConnections: true } },
  );
  mark("composio session+tools");

  await db.message.create({
    data: {
      instanceId,
      chatId,
      role: "user",
      content: [{ type: "text", text: userMessage }],
      source,
      ...(userMessageType && { messageType: userMessageType }),
    },
  });
  // Trim verbose Composio tool schemas to reduce token usage by ~40-60%.
  // This prevents free-tier TPM rate-limit errors with smaller models.
  const composioTools = optimizeToolSchemas(rawComposioTools);

  const customTools = createCustomTools(instanceId, chatId, userTimezone);

  // Per-request cache of restored (real) tool-call inputs/outputs, keyed by
  // toolCallId (prefixed with "out:" for outputs). Ensures restoreDeep() is
  // called at most once per tool call — Composio execution, DB persistence,
  // and UI re-render all read the SAME cached value.
  const restoreCache = new Map<string, unknown>();

  // Wrap tool executors with sanitization + optional PII redaction.
  // When a vault is active, tool results are scanned for PII and
  // sensitive values are replaced with tokens before the LLM sees them.
  const allTools: ToolSet = wrapToolExecutors(
    { ...composioTools, ...customTools },
    piiVault,
    restoreCache,
  );

  // Pre-create assistant message row so we can update it in onFinish
  const assistantMessageRow = await db.message.create({
    data: {
      instanceId,
      chatId,
      role: "assistant",
      content: toPrismaJson([]),
      source,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  });
  mark("message rows");

  const model = isOllama
    // Ollama needs provider-specific options (keep-alive, context size).
    ? ollamaProvider(chat.model, {
        keep_alive: -1,
        options: { num_ctx: getContextWindow(chat.model) },
      })
    // All other providers (OpenRouter-routed DeepSeek/Gemini/GPT/Llama, bare
    // Anthropic) are built by the shared provider-agnostic helper.
    : buildLLM(chat.model);

  // NOTE: The system prompt's user-supplied sections (soul/identity/user) were
  // already redacted above via redactSection(). Static sections (agent title,
  // tool descriptions, protocol, guidelines) are intentionally NOT scrubbed so
  // the agent name & product name are never tokenized.
  const safeSystemPrompt = systemPrompt;

  const agent = new ToolLoopAgent({
    model,
    instructions: {
      role: "system",
      content: safeSystemPrompt,
    // Only inject Anthropic cacheControl for Anthropic models.
    // Other providers don't support this option.
      ...(useAnthropicOptions && {
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      }),
    } satisfies SystemModelMessage,
    tools: allTools,
    // Step limit is set to 20 to prevent infinite runaway loops,
    // while still providing ample steps for complex agentic tool actions.
    stopWhen: stepCountIs(20),
    // Disable Qwen3 thinking mode to prevent empty-output errors
    // and cut token generation time in half.
    // maxTokens: 512 caps conversational replies; tool-call responses are
    // not bound by this since they stream until the tool schema is complete.
    ...(isOllama && {
      providerOptions: {
        ollama: { think: false },
      },
      maxTokens: 512,
    }),
    onFinish: async (result) => {
      await clearStreamingMessage(chatId).catch((error) =>
        console.error(
          "[agent/onFinish] clearStreamingMessage failed:",
          error,
        ),
      );
      try {
        const { totalUsage, steps, finishReason } = result;
        const inputTokens = totalUsage.inputTokens ?? 0;
        const outputTokens = totalUsage.outputTokens ?? 0;
        const cacheReadTokens =
          totalUsage.inputTokenDetails?.cacheReadTokens ?? 0;
        const cacheWriteTokens =
          totalUsage.inputTokenDetails?.cacheWriteTokens ?? 0;

        // Build assistant content from steps (UIMessage parts format)
        const assistantParts: Array<Record<string, unknown>> = [];

        for (const step of steps) {
          for (let i = 0; i < step.toolCalls.length; i++) {
            const tc = step.toolCalls[i]!;
            const tr = step.toolResults[i];
            const rawInput = toPlainRecordSafe(tc.input);
            const rawOutput = tr ? toPlainRecordSafe(tr.output) : null;
            const tid = tc.toolCallId;

            // Use the CACHED restored value (set once by wrapToolExecutors during
            // execution) so DB persistence stores the exact same value the tool saw,
            // without a second restoreDeep() per tool call. Falls back to restoring
            // now if the cache misses (e.g. tool executed outside the wrapper).
            const tcInput = piiVault
              ? ((restoreCache.get(tid) ?? piiVault.restoreDeep(rawInput)) as Record<
                  string,
                  unknown
                >)
              : rawInput;
            const tcResult = rawOutput
              ? piiVault
                ? ((restoreCache.get(`out:${tid}`) ?? piiVault.restoreDeep(rawOutput)) as Record<
                    string,
                    unknown
                  >)
                : rawOutput
              : null;

            assistantParts.push({
              type: "dynamic-tool" as const,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              state: tcResult ? "output-available" : "input-available",
              input: tcInput,
              output: tcResult ?? {},
            });
          }

          const stepText = stripToolResultEchoes(step.text);
          if (stepText) {
            // Restore PII tokens back to original values before persisting.
            // The database stores real data; only the LLM saw redacted tokens.
            // Strip any residual (orphan) token restore() cannot resolve so
            // the transcript never stores a raw placeholder that would re-leak.
            const restoredText = stripResidualTokens(
              piiVault ? piiVault.restore(stepText) : stepText,
            );
            assistantParts.push({ type: "text" as const, text: restoredText });
          }

          // Persist reasoning/thinking for replay in the chain-of-thought UI.
          // Restore PII tokens to real values so the human never sees tokens.
          const stepReasoning =
            step.reasoningText ??
            (step.reasoning?.length
              ? step.reasoning.map((r) => (r as { text?: string }).text ?? "").filter(Boolean).join("\n")
              : "");
          if (stepReasoning) {
            const restoredReasoning = stripResidualTokens(
              piiVault ? piiVault.restore(stepReasoning) : stepReasoning,
            );
            assistantParts.push({
              type: "reasoning" as const,
              text: restoredReasoning,
              state: "done" as const,
            });
          }
        }

        // Append truncation notice for Ollama models when the response
        // was cut off by the maxTokens limit.
        if (isOllama && finishReason === "length") {
          assistantParts.push({
            type: "text" as const,
            text: "\n\n[Response was truncated due to length limits]",
          });
        }

        // Update the pre-created assistant message with final content + totals
        await db.message.update({
          where: { id: assistantMessageRow.id },
          data: {
            content: toPrismaJson(assistantParts),
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
          },
        });

        // Fire-and-forget post-response tasks
        const totalContextTokens = inputTokens + outputTokens;
        // For qwen3:8b (32K context), use smaller reserve/keep windows so we
        // leave more of the context for actual conversation history.
        const ollamaCompactionSettings = {
          reserveTokens: 8_000,
          keepRecentTokens: 8_000,
        };
        const settings: CompactionSettings = {
          contextWindow,
          ...(isOllama ? ollamaCompactionSettings : DEFAULT_COMPACTION_SETTINGS),
        };

        void after(() =>
          runPostResponseTasks({
            instanceId,
            chatId,
            chat: {
              anthropicModel: chat.model,
              compactionCount: chat.compactionCount,
              compactionAttempts: chat.compactionAttempts,
              memoryFlushCount: chat.memoryFlushCount,
              lastCompactionSummary: chat.lastCompactionSummary,
              lastCompactionAt: chat.lastCompactionAt,
            },
            contextTokens: totalContextTokens,
            settings,
            prunedMessages,
            piiVault,
          }).catch((error) =>
            console.error("[agent/onFinish] post-response tasks failed:", error),
          ),
        );
      } catch (error) {
        console.error("[agent/onFinish] post-stream processing failed:", error);
      }
    },
  });

  // Create a deep-cloned array with redacted text for the LLM prompt.
  // We keep the original `prunedMessages` above for runPostResponseTasks.
  let redactedMessages = piiVault
    ? await redactContextMessages(prunedMessages, piiVault)
    : prunedMessages;

  // ── Final transport-layer checkpoint ──
  // After all per-layer redaction, run one final deep-scrub on the
  // fully-assembled message array. This catches any PII that leaked
  // through tool results, reasoning text, or partial redaction gaps.
  // The shield shares the same PIIVault, so tokens stay consistent.
  if (transportShield) {
    redactedMessages = (await transportShield.scrubPayload(
      redactedMessages as any,
    )) as typeof redactedMessages;
  }
  mark("setup complete (pre-first-token)");

  return {
    status: "ready",
    result: {
      agent,
      messages: redactedMessages,
      piiVault,
    },
  };
}

export type {
  PrepareAgentRunParams,
  PrepareResult,
  PrepareAgentRunResult,
  MessageSource,
};
