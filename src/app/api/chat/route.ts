import { db } from "~/server/clients/db";
import { smoothStream, UI_MESSAGE_STREAM_HEADERS } from "ai";
import { z } from "zod";
import { auth } from "~/server/auth";
import { prepareAgentRun } from "~/server/api/routers/nimits-jarvis/agent/setup";
import type { PIIVault } from "~/server/api/routers/nimits-jarvis/agent/pii";
import { stripResidualTokens } from "~/server/api/routers/nimits-jarvis/agent/pii/brands";
import { prewarmDeBERTa } from "~/server/api/routers/nimits-jarvis/agent/pii/deberta-classifier";
import {
  setStreamingMessage,
  getStreamingMessage,
} from "~/server/clients/redis";
import { rateLimit } from "~/server/clients/rate-limit";
import { getStreamContext } from "./stream-store";
import { TRPCError } from "@trpc/server";
import { getInstanceForUser } from "~/server/api/routers/nimits-jarvis/utils";

// Pre-warm DeBERTa model on first request (non-blocking)
let debertaPrewarmed = false;

const chatRequestBody = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant", "system"]),
      content: z.string().optional(),
      parts: z.array(z.record(z.string(), z.unknown())).optional(),
    }),
  ),
  instanceId: z.string().optional(),
  chatId: z.string().optional(),
  isVoice: z.boolean().optional(),
});

async function resolveChatId(instanceId: string, chatId?: string): Promise<string> {
  if (chatId) {
    const chat = await db.chat.findFirst({
      where: { id: chatId, instanceId },
      select: { id: true },
    });
    if (chat) return chat.id;
  }

  const firstChat = await db.chat.findFirst({
    where: { instanceId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  if (!firstChat) {
    const instance = await db.composioClawInstance.findUnique({
      where: { id: instanceId },
      select: { anthropicModel: true },
    });

    const createdChat = await db.chat.create({
      data: {
        instanceId,
        name: "New Chat",
        model: instance?.anthropicModel ?? "claude-3-7-sonnet-20250219",
      },
      select: { id: true },
    });

    return createdChat.id;
  }

  return firstChat.id;
}

/**
 * PII token pattern for detecting partial tokens at chunk boundaries.
 * Matches both bracket tokens [CLAW_TYPE_HASH] and email tokens CLAW_EMAIL_hash@trustclaw.anon.
 * Note: [A-Z_]+ matches multi-word types (PERSON_NAME, CREDIT_CARD, etc.).
 */
const PII_TOKEN_RE = /(?:\[CLAW_[A-Z_]+_[A-F0-9]{4}\]|CLAW_EMAIL_[A-F0-9]{4}@trustclaw\.anon)/g;

/**
 * Checks if the tail of a string starts what looks like a partial PII token.
 * Buffers any incomplete bracket or email token across SSE chunk boundaries.
 */
function partialTokenAtEnd(str: string): string {
  // Check for incomplete bracket token: [... without ]
  const lastBracket = str.lastIndexOf("[");
  if (lastBracket !== -1) {
    const tail = str.slice(lastBracket);
    if (tail.startsWith("[CLAW_") && !tail.includes("]")) return tail;
  }
  // Check for incomplete email token: CLAW_EMAIL_... without @trustclaw.anon
  const emailIdx = str.lastIndexOf("CLAW_EMAIL_");
  if (emailIdx !== -1) {
    const tail = str.slice(emailIdx);
    if (!tail.includes("@trustclaw.anon")) return tail;
  }
  return "";
}

/**
 * Creates a TransformStream that intercepts outbound SSE chunks and
 * restores PII tokens (e.g. `[EMAIL_1]`) back to original values
 * using the provided vault.
 *
 * Buffers across chunk boundaries so that tokens split between
 * two Uint8Array chunks (e.g. `[EMA` in one chunk, `IL_1]` in the next)
 * are still correctly restored.
 *
 * Works on raw Uint8Array chunks — decodes to text, applies restoration,
 * then re-encodes. Safe because SSE is UTF-8 text.
 */
function createPIIRestoreTransform(
  vault: PIIVault,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const carryOver = partialTokenAtEnd(buffer);
      const safe = buffer.slice(0, buffer.length - carryOver.length);
      buffer = carryOver;
      if (safe) {
        controller.enqueue(encoder.encode(stripResidualTokens(vault.restore(safe))));
      }
    },
    flush(controller) {
      const tail = decoder.decode();
      buffer += tail;
      const restored = stripResidualTokens(vault.restore(buffer));
      if (restored) {
        controller.enqueue(encoder.encode(restored));
      }
    },
  });
}

/**
 * Creates a TransformStream for string-based SSE streams (used inside
 * consumeSseStream). Same buffering logic as createPIIRestoreTransform
 * but operating on string chunks instead of Uint8Array.
 */
function createPIIRestoreStringTransform(
  vault: PIIVault,
): TransformStream<string, string> {
  let buffer = "";

  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;
      const carryOver = partialTokenAtEnd(buffer);
      const safe = buffer.slice(0, buffer.length - carryOver.length);
      buffer = carryOver;
      if (safe) {
        controller.enqueue(stripResidualTokens(vault.restore(safe)));
      }
    },
    flush(controller) {
      const restored = stripResidualTokens(vault.restore(buffer));
      if (restored) {
        controller.enqueue(restored);
      }
    },
  });
}

export const maxDuration = 300;

export async function POST(request: Request) {
  // Pre-warm DeBERTa model on first request (non-blocking)
  if (!debertaPrewarmed) {
    debertaPrewarmed = true;
    prewarmDeBERTa();
  }

  const body = chatRequestBody.safeParse(await request.json());
  if (!body.success) {
    return new Response("Invalid request body", { status: 400 });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const userId = session.user.id;

  const lastUserMessage = [...body.data.messages]
    .reverse()
    .find((m) => m.role === "user");
  const userText =
    lastUserMessage?.parts
      ?.filter(
        (p): p is { type: string; text: string } =>
          typeof p === "object" &&
          p !== null &&
          "type" in p &&
          p.type === "text" &&
          "text" in p &&
          typeof p.text === "string",
      )
      .map((p) => p.text)
      .join("\n") ?? "";
  if (!userText.trim()) {
    return new Response("Empty message", { status: 400 });
  }

  const limit = await rateLimit(userId, "chat");
  if (!limit.allowed) {
    return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(limit.retryAfterSeconds),
      },
    });
  }

  // Derive instanceId + chatId, preferring chatId (which knows its instance)
  let instanceId = body.data.instanceId;
  let chatId = body.data.chatId;

  if (chatId) {
    const chat = await db.chat.findUnique({
      where: { id: chatId },
      select: { id: true, instanceId: true, instance: { select: { userId: true } } },
    });

    if (!chat || chat.instance.userId !== userId) {
      return new Response("Chat not found", { status: 404 });
    }

    instanceId = chat.instanceId;
  }

  if (!instanceId) {
    const instance = await getInstanceForUser(userId);
    instanceId = instance.id;
  }

  if (!chatId) {
    chatId = await resolveChatId(instanceId);
  }

  const prepareResult = await prepareAgentRun({
    instanceId,
    chatId,
    userMessage: userText,
    source: "web",
    isVoice: body.data.isVoice ?? false,
  });

  const { agent, messages, piiVault } = prepareResult.result;

  const streamId = crypto.randomUUID();
  await setStreamingMessage(chatId, streamId);

  // agent.stream() returns streamText() result - supports toUIMessageStreamResponse
  // Pass request.signal so the agent stops when the client disconnects (stop button)
  const result = await agent.stream({
    prompt: messages,
    experimental_transform: smoothStream(),
    abortSignal: request.signal,
  });

  const streamContext = getStreamContext();
  const response = result.toUIMessageStreamResponse({
    headers: {
      "X-Stream-Id": streamId,
    },
    ...(streamContext
      ? {
          consumeSseStream: ({ stream }) => {
            const finalStream = piiVault
              ? stream.pipeThrough(createPIIRestoreStringTransform(piiVault))
              : stream;

            void streamContext.createNewResumableStream(
              streamId,
              () => finalStream,
            );
          },
        }
      : {}),
  });

  // Whenever a vault is active (and even when it has no new registrations this
  // request), wrap the response body with a transform that restores PII tokens
  // back to original values and strips any token restore() cannot resolve so a
  // placeholder never reaches the user. The SSE stream contains text like
  // "[CLAW_PERSON_NAME_542F] sent you a message" which we rewrite to
  // "John Doe sent you a message".
  if (piiVault && response.body) {
    const restored = response.body.pipeThrough(
      createPIIRestoreTransform(piiVault),
    );
    return new Response(restored, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  return response;
}

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const userId = session.user.id;
  const url = new URL(request.url);
  const streamId = url.searchParams.get("streamId");
  const chatIdParam = url.searchParams.get("chatId");
  const instanceIdParam = url.searchParams.get("instanceId");

  if (!streamId) {
    return new Response("Missing streamId", { status: 400 });
  }

  let chatId: string | undefined;

  if (chatIdParam) {
    const chat = await db.chat.findUnique({
      where: { id: chatIdParam },
      select: { id: true, instance: { select: { userId: true } } },
    });

    if (!chat || chat.instance.userId !== userId) {
      return new Response("Chat not found", { status: 404 });
    }

    chatId = chat.id;
  } else {
    const instance = await getInstanceForUser(userId, instanceIdParam ?? undefined);
    chatId = await resolveChatId(instance.id);
  }

  const activeStreamId = await getStreamingMessage(chatId);
  if (activeStreamId !== streamId) {
    return new Response("Stream not found or not yours", { status: 404 });
  }

  const streamContext = getStreamContext();
  if (!streamContext) {
    return new Response("Stream resumption not available", { status: 204 });
  }
  const stream = await streamContext.resumeExistingStream(streamId);
  if (!stream) {
    return new Response("Stream already completed", { status: 204 });
  }

  return new Response(stream.pipeThrough(new TextEncoderStream()), {
    headers: UI_MESSAGE_STREAM_HEADERS,
  });
}
