import { z } from "zod";
import moment from "moment-timezone";
import { db } from "~/server/clients/db";
import type { Prisma } from "~/generated/prisma/client";
import type {
  ReconstructedMessage,
  JsonValue,
  ToolResultOutput,
} from "../types";
import {
  shouldCompact,
  shouldFlushMemory,
  type CompactionSettings,
} from "./token-estimation";
import { runCompaction } from "../compaction/run-compaction";
import { runMemoryFlush } from "../compaction/memory-flush";
import { COMPACTION_SUMMARY_PREFIX } from "../compaction/prompts";
import {
  collectInvokedSlugs,
  collapseSpentSearchResult,
  stripToolResultBoilerplate,
  SEARCH_TOOLS,
} from "../tool-evict";
import { reduceToolResultOutput } from "../tool-results/reduce";
import type { PIIVault } from "../pii";

const MESSAGE_SAFETY_CAP = 200;

// Lone surrogates in strings produce invalid JSON when serialized for the Anthropic API.
// This can happen when external tool results (e.g. from Composio) contain malformed Unicode.
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function sanitizeString(str: string): string {
  return str.replace(LONE_SURROGATE_RE, "\uFFFD");
}

function deepSanitize<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeString(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(deepSanitize) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepSanitize(v);
    }
    return out as T;
  }
  return value;
}

export const contentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  gloss: z.string().optional(),
  display_name: z.string().optional(),
});

export const contentSchema = z.array(contentPartSchema);

export const plainRecordSchema = z.record(z.string(), z.unknown());

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export { sanitizeString, deepSanitize };

export function toJsonValue(value: unknown): JsonValue {
  const parsed = jsonValueSchema.safeParse(value ?? {});
  return parsed.success ? deepSanitize(parsed.data) : {};
}

export function toToolResultOutput(value: unknown): ToolResultOutput {
  return { type: "json", value: toJsonValue(value) };
}

export function toPlainRecord(value: unknown): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(JSON.stringify(value ?? {}));
    return plainRecordSchema.parse(raw);
  } catch {
    return {};
  }
}

export function toPlainRecordSafe(value: unknown): Record<string, unknown> {
  const result = plainRecordSchema.safeParse(
    JSON.parse(JSON.stringify(value ?? {})),
  );
  if (!result.success) {
    console.error(
      "[toPlainRecordSafe] Non-record tool input fell back to {}:",
      typeof value,
    );
  }
  return result.success ? result.data : {};
}

export function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return toJsonValue(
    JSON.parse(JSON.stringify(value ?? {})),
  ) satisfies JsonValue as Prisma.InputJsonValue;
}

export async function loadContextMessages(
  instanceId: string,
  chatId: string,
  lastCompactionAt: Date | null,
) {
  // Prisma applies `take` at the database query level, so ordering matters
  // when more than MESSAGE_SAFETY_CAP regular messages exist since the last
  // compaction point. We want the NEWEST capped messages (recent context is
  // what matters to the agent), so order descending, take the cap, then
  // reverse back into chronological order before returning.
  const rows = await db.message.findMany({
    where: {
      instanceId,
      chatId,
      messageType: "regular",
      ...(lastCompactionAt ? { createdAt: { gte: lastCompactionAt } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: MESSAGE_SAFETY_CAP,
    select: {
      id: true,
      role: true,
      content: true,
      attachments: {
        select: { id: true, mimeType: true, width: true, height: true, summary: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  return rows.reverse();
}

/**
 * Volatile context injected at the END of the final user message —
 * everything here changes between requests, so it must never sit inside the
 * cached prefix (docs/TOKEN_EFFICIENCY.md §3.1).
 */
export interface VolatileTail {
  relevantMemories?: string[];
  userTimezone?: string;
  /** Per-message mode lines (fs access, voice) — see buildVolatileModeLines */
  modeLines?: string;
}

/** Image derivative payload for the current turn only. Base64, survives sanitize. */
export interface CurrentTurnAttachment {
  mediaType: string;
  data: string;
  filename?: string;
}

export function buildContext(
  dbMessages: Awaited<ReturnType<typeof loadContextMessages>>,
  lastCompactionSummary: string | null,
  userMessage: string,
  volatile?: VolatileTail,
  attachments?: CurrentTurnAttachment[],
): ReconstructedMessage[] {
  const aiMessages = deepSanitize(reconstructMessages(dbMessages));

  if (lastCompactionSummary) {
    aiMessages.unshift({
      role: "user" as const,
      content: sanitizeString(
        `${COMPACTION_SUMMARY_PREFIX}\n\n<summary>\n${lastCompactionSummary}\n</summary>`,
      ),
    });
  }

  let finalUserMessage = "";
  const timezone = volatile?.userTimezone;
  if (timezone) {
    const userTime = moment().tz(timezone);
    finalUserMessage += `[Current Time: ${userTime.format("dddd, MMMM D, YYYY h:mm A")} (${timezone})]\n\n`;
  }
  const memoryLines = (volatile?.relevantMemories ?? [])
    .map((m) => `- ${m}`)
    .join("\n");
  if (memoryLines) {
    finalUserMessage += `[Relevant Memories]\n${memoryLines}\n\n`;
  }
  if (volatile?.modeLines) {
    finalUserMessage += `[Mode]\n${volatile.modeLines}\n\n`;
  }
  finalUserMessage += userMessage;

  if (attachments && attachments.length > 0) {
    const n = attachments.length;
    const preamble = `Attached images in order: ${Array.from({ length: n }, (_, i) => `Image ${i + 1}`).join(", ")}.`;
    aiMessages.push({
      role: "user" as const,
      content: [
        { type: "text" as const, text: sanitizeString(preamble) },
        ...attachments.map((a) => ({
          type: "file" as const,
          mediaType: a.mediaType,
          data: a.data,
          ...(a.filename ? { filename: a.filename } : {}),
        })),
        { type: "text" as const, text: sanitizeString(finalUserMessage) },
      ],
    });
    return aiMessages;
  }

  aiMessages.push({
    role: "user" as const,
    content: sanitizeString(finalUserMessage),
  });

  return aiMessages;
}

const dynamicToolPartSchema = z.object({
  type: z.literal("dynamic-tool"),
  toolCallId: z.string(),
  toolName: z.string(),
  display_name: z.string().optional(),
  state: z.string(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
});

export function reconstructMessages(
  messages: Array<{
    role: string;
    content: unknown;
    attachments?: Array<{ id: string; mimeType: string; width: number; height: number; summary: string | null }>;
  }>,
): ReconstructedMessage[] {
  const result: ReconstructedMessage[] = [];

  // §2.1 — pre-pass: which slugs does this batch actually invoke later?
  const invokedSlugs = collectInvokedSlugs(messages);

  // §4.4 — pre-pass: index of the LAST assistant row carrying tool parts.
  // Reduction age = how many assistant steps back the result sits.
  let lastToolRowIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    if (
      (msg.content as Array<Record<string, unknown>>).some(
        (p) => p?.type === "dynamic-tool",
      )
    ) {
      lastToolRowIndex = i;
    }
  }

  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex]!;
    const role = msg.role === "assistant" ? "assistant" : "user";

    const contentArray = Array.isArray(msg.content) ? msg.content : [];
    const parsed = contentSchema.safeParse(contentArray);
    const contentParts = parsed.success ? parsed.data : [];

    const textContent = contentParts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join("\n");

    if (role === "user") {
      // Historical images are compact text references, never bytes (§7.1).
      // Deterministic serialization: fixed key order, no timestamps.
      const refs = (msg.attachments ?? []).map((a, i) => {
        const dims = `${a.width}x${a.height}`;
        const summary = a.summary ?? `image, ${dims}`;
        return `{"$image": {"id": "${a.id}", "index": ${i + 1}, "mimeType": "${a.mimeType}", "dimensions": "${dims}", "summary": ${JSON.stringify(summary)}}}`;
      });
      const body = [textContent || "(empty)", ...refs].join("\n");
      result.push({ role: "user", content: body });
      continue;
    }

    // Extract dynamic-tool parts from content JSON
    const toolParts = contentArray
      .map((item: unknown) => dynamicToolPartSchema.safeParse(item))
      .filter(
        (
          r,
        ): r is z.ZodSafeParseSuccess<z.infer<typeof dynamicToolPartSchema>> =>
          r.success,
      )
      .map((r) => r.data);

    if (toolParts.length === 0) {
      result.push({ role: "assistant", content: textContent || "(empty)" });
      continue;
    }

    const assistantContent: Array<
      | { type: "text"; text: string }
      | {
          type: "tool-call";
          toolCallId: string;
          toolName: string;
          input: Record<string, unknown>;
        }
      | { type: "reasoning"; text: string; gloss?: string }
    > = [];
    if (textContent) {
      assistantContent.push({ type: "text", text: textContent });
    }
    for (const tc of toolParts) {
      assistantContent.push({
        type: "tool-call",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: toPlainRecordSafe(tc.input),
      });
    }
    result.push({ role: "assistant", content: assistantContent });

    const age = Math.max(0, lastToolRowIndex - msgIndex);
    result.push({
      role: "tool",
      content: toolParts.map((tc) => {
        // §2 responses
        let output = toToolResultOutput(tc.output);
        if (tc.toolName === SEARCH_TOOLS) {
          const collapsed = collapseSpentSearchResult(
            tc.input,
            tc.output,
            invokedSlugs,
          );
          if (collapsed) output = collapsed;
        }
        if (output.type === "json") {
          output = {
            type: "json",
            value: stripToolResultBoilerplate(output.value),
          };
        }
        // §4.3/4.4 — age-decay: full for the current step, structured
        // reduction for older steps. Always addressable via read_tool_result.
        output = reduceToolResultOutput(
          output,
          age,
          tc.toolCallId,
          tc.toolName,
        );
        return {
          type: "tool-result" as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          output,
        };
      }),
    });
  }

  return result;
}

export async function runPostResponseTasks(params: {
  instanceId: string;
  chatId: string;
  chat: {
    anthropicModel: string;
    compactionCount: number;
    compactionAttempts: number;
    memoryFlushCount: number;
    lastCompactionSummary: string | null;
    lastCompactionAt: Date | null;
  };
  contextTokens: number;
  settings: CompactionSettings;
  prunedMessages: ReconstructedMessage[];
  piiVault: PIIVault | null;
}): Promise<void> {
  const {
    instanceId,
    chatId,
    chat,
    contextTokens,
    settings,
    prunedMessages,
    piiVault,
  } = params;

  if (
    shouldFlushMemory(
      contextTokens,
      settings,
      chat.compactionCount,
      chat.memoryFlushCount,
    )
  ) {
    try {
      await runMemoryFlush({
        chatId,
        instanceId,
        anthropicModel: chat.anthropicModel,
        messages: prunedMessages,
        compactionCount: chat.compactionCount,
        piiVault,
      });
    } catch {
      // Flush failure is non-fatal
    }
  }

  if (shouldCompact(contextTokens, settings)) {
    try {
      const freshDbMessages = await loadContextMessages(
        instanceId,
        chatId,
        chat.lastCompactionAt,
      );
      const freshAiMessages = reconstructMessages(freshDbMessages);

      await runCompaction({
        chatId,
        anthropicModel: chat.anthropicModel,
        messages: freshAiMessages,
        keepRecentTokens: settings.keepRecentTokens,
        previousSummary: chat.lastCompactionSummary,
        compactionCount: chat.compactionCount,
        compactionAttempts: chat.compactionAttempts,
      });
    } catch {
      // Compaction failure is non-fatal - next turn will retry
    }
  }
}
