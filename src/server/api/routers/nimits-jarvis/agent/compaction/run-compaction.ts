// Adapted from pi-mono: packages/coding-agent/src/core/compaction/compaction.ts:376-438 (cut point algorithm)
// Adaptive chunking / staged summarization from openclaw: src/agents/compaction.ts:110-129, 244-305
// Fallback chain from openclaw: src/agents/compaction.ts:176-242
import { generateText } from "ai";
import { db } from "~/server/clients/db";
import type { ReconstructedMessage } from "../types";
import { estimateMessageTokens } from "../context/token-estimation";
import {
  COMPACTION_SYSTEM_PROMPT,
  INITIAL_SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
  MERGE_SUMMARIES_PROMPT,
  serializeMessages,
  buildToolFailuresSuffix,
} from "./prompts";
import { sanitizeString } from "../context/build-context";
import { getModelProvider, buildLLM, llmTimeoutFor } from "../model-utils";
import { computeSummarizationBudget } from "../context/context-window";
import { PIIVault } from "../pii";

interface CompactionParams {
  chatId: string;
  anthropicModel: string;
  messages: ReconstructedMessage[];
  keepRecentTokens: number;
  previousSummary: string | null;
  compactionCount: number;
  compactionAttempts: number;
}

interface CompactionResult {
  summary: string;
  keptMessageCount: number;
  compactedMessageCount: number;
}

const ADAPTIVE_CHUNK_THRESHOLD = 100_000;
const LARGE_TOOL_RESULT_THRESHOLD = 10_000;
const MAX_COMPACTION_ATTEMPTS = 3;

export function findCutPoint(
  messages: ReconstructedMessage[],
  keepRecentTokens: number,
): number {
  if (messages.length <= 2) return 0;

  let accumulatedTokens = 0;
  let foundCut = false;
  let rawCutIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    accumulatedTokens += estimateMessageTokens(messages[i]!);
    if (accumulatedTokens >= keepRecentTokens) {
      rawCutIndex = i;
      foundCut = true;
      break;
    }
  }

  if (!foundCut) return 0;

  for (let i = rawCutIndex; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "user" || msg.role === "assistant") {
      return i;
    }
  }

  return 0;
}

async function summarize(
  anthropicModel: string,
  conversationText: string,
  previousSummary: string | null,
): Promise<string> {
  const model = buildLLM(anthropicModel);

  // Redact PII before sending to external LLMs.
  // Local Ollama models are exempt since data stays on-device.
  const vault = getModelProvider(anthropicModel) !== "ollama" ? new PIIVault() : null;

  const safeConversation = sanitizeString(conversationText);
  const safePreviousSummary = previousSummary ? sanitizeString(previousSummary) : null;

  const redactedConversation = vault ? await vault.redact(safeConversation) : safeConversation;
  const redactedPreviousSummary = vault && safePreviousSummary
    ? await vault.redact(safePreviousSummary)
    : safePreviousSummary;

  let prompt: string;
  if (redactedPreviousSummary) {
    prompt = `<conversation>\n${redactedConversation}\n</conversation>\n\n<previous-summary>\n${redactedPreviousSummary}\n</previous-summary>\n\n${UPDATE_SUMMARIZATION_PROMPT}`;
  } else {
    prompt = `<conversation>\n${redactedConversation}\n</conversation>\n\n${INITIAL_SUMMARIZATION_PROMPT}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), llmTimeoutFor(prompt));

  try {
    const result = await generateText({
      model,
      system: COMPACTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      maxOutputTokens: 4_000,
      abortSignal: controller.signal,
    });

    // Restore PII in the summary before persisting to the database
    return vault ? vault.restore(result.text) : result.text;
  } finally {
    clearTimeout(timeout);
  }
}

async function stagedSummarize(
  anthropicModel: string,
  messages: ReconstructedMessage[],
  previousSummary: string | null,
): Promise<string> {
  const midpoint = Math.floor(messages.length / 2);
  const firstHalf = messages.slice(0, midpoint);
  const secondHalf = messages.slice(midpoint);

  const firstText = serializeMessages(firstHalf);
  const secondText = serializeMessages(secondHalf);

  const firstSummary = await summarize(
    anthropicModel,
    firstText,
    previousSummary,
  );

  const secondSummary = await summarize(
    anthropicModel,
    secondText,
    firstSummary,
  );

  const mergeModel = buildLLM(anthropicModel);

  // Redact PII before the merge call. firstSummary and secondSummary were
  // already restored by their individual summarize() calls, so they contain
  // real PII values that must be redacted before reaching an external merge LLM.
  const mergeVault = getModelProvider(anthropicModel) !== "ollama" ? new PIIVault() : null;
  const mergeContent = `<summary-1>\n${firstSummary}\n</summary-1>\n\n<summary-2>\n${secondSummary}\n</summary-2>\n\n${MERGE_SUMMARIES_PROMPT}`;
  const safeMergeContent = mergeVault ? await mergeVault.redact(mergeContent) : mergeContent;

  const mergeController = new AbortController();
  const mergeTimeout = setTimeout(() => mergeController.abort(), llmTimeoutFor(safeMergeContent));

  try {
    const mergeResult = await generateText({
      model: mergeModel,
      system: COMPACTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: safeMergeContent }],
      maxOutputTokens: 4_000,
      abortSignal: mergeController.signal,
    });

    return mergeVault ? mergeVault.restore(mergeResult.text) : mergeResult.text;
  } finally {
    clearTimeout(mergeTimeout);
  }
}

function stripLargeToolResults(
  messages: ReconstructedMessage[],
): ReconstructedMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    return {
      ...msg,
      content: msg.content.map((part) => {
        const outputStr = JSON.stringify(part.output);
        if (outputStr.length > LARGE_TOOL_RESULT_THRESHOLD) {
          return { ...part, output: { type: "text" as const, value: "[Large tool result omitted]" } };
        }
        return part;
      }),
    };
  });
}

/**
 * Last-resort fallback when LLM summarization fails: keep the last `n`
 * user/assistant TEXT messages verbatim so the human's intent is never lost.
 * Returns the string to use as the summary, or null if there is no text content.
 */
export function keepLastTextFallback(
  messages: ReconstructedMessage[],
  n = 5,
): string | null {
  const lines: string[] = [];
  // Walk newest-first so we keep the most recent text turns.
  for (let i = messages.length - 1; i >= 0 && lines.length < n; i--) {
    const msg = messages[i]!;
    if (msg.role === "user") {
      lines.unshift(`[User]: ${msg.content}`);
      continue;
    }
    if (msg.role === "assistant" && typeof msg.content === "string") {
      lines.unshift(`[Assistant]: ${msg.content}`);
      continue;
    }
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const text = msg.content
        .filter((p) => p.type === "text" && Boolean((p as { text?: string }).text))
        .map((p) => (p as { text: string }).text)
        .join("\n");
      if (text) lines.unshift(`[Assistant]: ${text}`);
    }
  }
  if (lines.length === 0) return null;
  return lines.join("\n");
}

export async function runCompaction(
  params: CompactionParams,
): Promise<CompactionResult | null> {
  const { chatId, anthropicModel, messages, keepRecentTokens, previousSummary, compactionCount, compactionAttempts } = params;

  // If compaction has failed multiple times in a row, skip this cycle
  // to avoid wasting tokens on a persistent failure (e.g., context too large
  // for the model, corrupted data). The counter resets on the next successful
  // compaction or when the user manually triggers it.
  if (compactionAttempts >= MAX_COMPACTION_ATTEMPTS) {
    console.warn("[compaction] skipped: max attempts reached", { compactionAttempts });
    return null;
  }

  const cutIndex = findCutPoint(messages, keepRecentTokens);
  if (cutIndex <= 0) return null;

  const messagesToCompact = messages.slice(0, cutIndex);
  const keptMessageCount = messages.length - cutIndex;

  let summary: string;
  let llmFailed = false;

  // Derive a safe char budget from this model's context window (generalized
  // across all providers) so we never send an oversized payload to the model.
  const budget = computeSummarizationBudget(anthropicModel);

  try {
    const conversationText = serializeMessages(messagesToCompact);
    // Truncate oversized conversations to the model budget, preserving the
    // MOST RECENT content (truncate from the front).
    const capped = conversationText.length > budget
      ? `... [earlier context omitted] ...\n${conversationText.slice(-budget)}`
      : conversationText;

    if (capped.length > ADAPTIVE_CHUNK_THRESHOLD) {
      summary = await stagedSummarize(
        anthropicModel,
        messagesToCompact,
        previousSummary,
      );
    } else {
      summary = await summarize(
        anthropicModel,
        capped,
        previousSummary,
      );
    }
  } catch (error) {
    console.warn("[compaction] summarize failed, retrying without large tool results:", error);
    llmFailed = true;
    try {
      const stripped = stripLargeToolResults(messagesToCompact);
      const strippedText = serializeMessages(stripped);
      const cappedStripped = strippedText.length > budget
        ? `... [earlier context omitted] ...\n${strippedText.slice(-budget)}`
        : strippedText;
      summary = await summarize(
        anthropicModel,
        cappedStripped,
        previousSummary,
      );
      llmFailed = false;
    } catch (innerError) {
      console.warn("[compaction] stripped summarize also failed:", innerError);
      // Better last-resort: preserve the most recent human intent verbatim.
      const fallback = keepLastTextFallback(messagesToCompact, 5);
      summary = fallback
        ? `Conversation compaction summary unavailable. Most recent messages preserved verbatim:\n\n${fallback}`
        : `Conversation covered ${messagesToCompact.length} messages. Summary unavailable due to context limits.`;
    }
  }

  const failuresSuffix = buildToolFailuresSuffix(messagesToCompact);
  if (failuresSuffix) {
    summary += failuresSuffix;
  }

  const estimatedTokens = Math.ceil(summary.length / 4);

  try {
    await db.chat.update({
      where: { id: chatId, compactionCount },
      data: {
        lastCompactionSummary: summary,
        compactionCount: { increment: 1 },
        compactionAttempts: 0,
        lastCompactionAt: new Date(),
        tokensAtCompaction: estimatedTokens,
      },
    });
  } catch {
    // Optimistic lock failure — another compaction ran first, or a transient
    // DB error. Increment attempts to prevent rapid retry loops.
    await db.chat
      .update({
        where: { id: chatId },
        data: { compactionAttempts: { increment: 1 } },
      })
      .catch(() => {});
    console.warn("[compaction] DB update failed (optimistic lock or transient error)");
    return null;
  }

  // If the LLM calls failed but we still produced a fallback summary,
  // increment attempts so we don't keep retrying with a broken model.
  if (llmFailed) {
    await db.chat
      .update({
        where: { id: chatId },
        data: { compactionAttempts: { increment: 1 } },
      })
      .catch(() => {});
  }

  return {
    summary,
    keptMessageCount,
    compactedMessageCount: cutIndex,
  };
}
