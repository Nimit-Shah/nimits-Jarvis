import { db } from "~/server/clients/db";
import { smoothStream, UI_MESSAGE_STREAM_HEADERS } from "ai";
import { z } from "zod";
import { auth } from "~/server/auth";
import { prepareAgentRun } from "~/server/api/routers/nimits-jarvis/agent/setup";
import { formatStreamError } from "~/server/api/routers/nimits-jarvis/agent/error-parser";
import { PIIVault } from "~/server/api/routers/nimits-jarvis/agent/pii";
import { decrypt } from "~/lib/crypto";
import { stripResidualTokens } from "~/server/api/routers/nimits-jarvis/agent/pii/brands";
import { prewarmDeBERTa } from "~/server/api/routers/nimits-jarvis/agent/pii/deberta-classifier";
import {
  claimChatRun,
  claimIdempotencyKey,
  clearVaultSnapshot,
  getStreamingMessage,
  getVaultSnapshot,
  peekIdempotencyKey,
  persistVaultSnapshot,
  releaseChatRun,
  setRunAssistant,
  takeRunAssistant,
} from "~/server/clients/redis";
import {
  canBackground,
  cancelRun,
  registerRun,
  releaseRun,
  startRunHeartbeat,
} from "~/server/lib/run-registry";
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
  // Per-message filesystem access mode — clamped server-side against the
  // instance ceiling in prepareAgentRun (resolveFsMode). Unknown values are
  // rejected, not coerced.
  fsAccessMode: z.enum(["read-only", "full"]).optional(),
  // Skills pinned from the composer menu for this message. Validated
  // server-side against the user's own rows; stale/foreign slugs dropped.
  pinnedSkills: z.array(z.string().min(1).max(64)).max(10).optional(),
  // Ordered image attachment ids for this turn. Validated server-side for
  // ownership; stale/foreign ids dropped silently. Absent = text-only.
  attachmentIds: z.array(z.string().cuid()).max(20).optional(),
  // Client-generated UUID per send. Retried/double-fired submits sharing one
  // key attach to the first run instead of starting a second one.
  idempotencyKey: z.string().max(128).optional(),
});

/**
 * PII token pattern for detecting partial tokens at chunk boundaries.
 * Matches both bracket tokens [CLAW_TYPE_HASH] and email tokens CLAW_EMAIL_hash@trustclaw.anon.
 * Note: [A-Z_]+ matches multi-word types (PERSON_NAME, CREDIT_CARD, etc.).
 */
const PII_TOKEN_RE =
  /(?:\[CLAW_[A-Z_]+_[A-F0-9]{4}\]|CLAW_EMAIL_[A-F0-9]{4}@trustclaw\.anon)/g;

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
        controller.enqueue(
          encoder.encode(stripResidualTokens(vault.restore(safe))),
        );
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

/**
 * Records the latency from stream start to the first outbound SSE byte —
 * a server-side proxy for TTFT (§0.1 instrumentation). Side-effect free:
 * every chunk passes through untouched.
 */
function firstByteTimingTransform(
  record: (ms: number) => void,
): TransformStream<Uint8Array, Uint8Array> {
  let started = false;
  const t0 = Date.now();
  return new TransformStream({
    transform(chunk, controller) {
      if (!started) {
        started = true;
        record(Date.now() - t0);
      }
      controller.enqueue(chunk);
    },
  });
}

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
  if (!userText.trim() && !(body.data.attachmentIds && body.data.attachmentIds.length > 0)) {
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
      select: {
        id: true,
        instanceId: true,
        instance: { select: { userId: true } },
      },
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

  // Lazy thread creation: an unsaved New Chat posts without a chatId and
  // the thread is born here, on the first submitted message — never before.
  let createdHere = false;
  if (!chatId) {
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
    chatId = createdChat.id;
    createdHere = true;
  }

  const streamId = crypto.randomUUID();

  // Idempotency, part 1 (read-only probe): a retried/double-fired submit
  // reuses the first run's ids so the client can attach instead of spawning
  // a second agent. No rows are written on this path.
  if (body.data.idempotencyKey) {
    const prior = await peekIdempotencyKey(body.data.idempotencyKey);
    if (prior) {
      console.log("[chat] duplicate submit deduplicated (peek)", {
        chatId: prior.chatId,
        streamId: prior.streamId,
      });
      return new Response(
        JSON.stringify({
          error: "run_in_progress",
          activeStreamId: prior.streamId,
          chatId: prior.chatId,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
  }
  // Idempotency, part 2 (winning claim with the now-known chatId). Losing
  // a race here means a twin request already owns this key: drop any
  // just-created orphan thread and attach to the winner.
  if (body.data.idempotencyKey) {
    const winner = await claimIdempotencyKey(
      body.data.idempotencyKey,
      streamId,
      chatId,
    );
    if (winner) {
      console.log("[chat] duplicate submit deduplicated (claim)", {
        chatId: winner.chatId,
        streamId: winner.streamId,
      });
      if (createdHere) {
        await db.chat.delete({ where: { id: chatId } }).catch(() => {
          // Best-effort orphan cleanup; TTL + cascade cover the rest.
        });
      }
      return new Response(
        JSON.stringify({
          error: "run_in_progress",
          activeStreamId: winner.streamId,
          chatId: winner.chatId,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // In-flight guard: one agent run per chat. Claim BEFORE prepareAgentRun
  // (which writes the user row) so a rejected submit leaves no trace.
  const claimed = await claimChatRun(chatId, streamId);
  if (!claimed) {
    const active = await getStreamingMessage(chatId);
    console.log("[chat] concurrent POST rejected", { chatId, active });
    return new Response(
      JSON.stringify({
        error: "run_in_progress",
        activeStreamId: active,
        chatId,
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  }

  let prepareResult;
  try {
    prepareResult = await prepareAgentRun({
      instanceId,
      chatId,
      userMessage: userText,
      source: "web",
      isVoice: body.data.isVoice ?? false,
      fsAccessMode: body.data.fsAccessMode,
      pinnedSkills: body.data.pinnedSkills,
      attachmentIds: body.data.attachmentIds,
      streamId,
    });
  } catch (error) {
    // prepareAgentRun writes rows before it can fail — release the claim so
    // the chat is not blocked, then propagate the failure.
    console.error("[chat] prepareAgentRun failed:", error);
    releaseRun(streamId);
    await releaseChatRun(chatId, streamId);
    // Capability rejection is operator-actionable (switch models), not a
    // server fault — surface as 400 with the model's own message.
    if (error instanceof Error && error.message.startsWith("MODEL_NO_VISION:")) {
      return new Response(error.message.replace(/^MODEL_NO_VISION:\s*/, ""), { status: 400 });
    }
    return new Response(formatStreamError(error), { status: 500 });
  }

  const { agent, messages, piiVault, metrics, assistantMessageId } =
    prepareResult.result;

  const markRunStatus = async (runStatus: string, noticeOverride?: string) => {
    try {
      const row = await db.message.findUnique({
        where: { id: assistantMessageId },
        select: { runStatus: true, content: true },
      });
      // Never overwrite a terminal state written by onFinish.
      if (row?.runStatus) return;
      const content = row?.content;
      const contentEmpty = !Array.isArray(content) || content.length === 0;
      // Interrupted before any step checkpoint wrote content — leave a
      // terminal notice instead of a silent empty assistant bubble.
      const notice =
        noticeOverride ??
        (runStatus === "timed_out"
          ? "Run timed out before any output was saved."
          : runStatus === "failed"
            ? "Run failed before any output was saved."
            : runStatus === "cancelled" || runStatus === "aborted"
              ? "Run was cancelled before any output was saved."
              : `Run ${runStatus} before any output was saved.`);
      await db.message.update({
        where: { id: assistantMessageId },
        data: {
          runStatus,
          ...(contentEmpty
            ? { content: [{ type: "text", text: notice }] }
            : {}),
        },
      });
    } catch (err) {
      console.error("[chat] run-status marking failed:", err);
    }
  };

  const runController = registerRun(streamId);
  startRunHeartbeat(chatId, streamId);
  // Link the stream to its pre-created assistant row for out-of-band
  // terminal marking (explicit cancel).
  await setRunAssistant(streamId, assistantMessageId);

  // Client disconnect: in background-capable runtimes the run continues
  // (chat switches unmount the stream without killing it); otherwise the
  // disconnect aborts generation with it. Either way the row must never be
  // a silent empty message.
  request.signal.addEventListener("abort", () => {
    if (canBackground) {
      console.info("[chat] client disconnected, run continues in background", {
        chatId,
        streamId,
      });
      return;
    }
    console.info("[chat] client disconnected mid-run", { chatId, streamId });
    void (async () => {
      await markRunStatus("aborted");
      releaseRun(streamId);
      await releaseChatRun(chatId, streamId);
    })();
  });

  // agent.stream() returns streamText() result - supports toUIMessageStreamResponse.
  // The run listens to the registry controller where background continuation
  // is possible, else to the request (serverless: the run cannot outlive it).
  const runSignal = canBackground ? runController.signal : request.signal;
  let result;
  try {
    result = await agent.stream({
      prompt: messages,
      experimental_transform: smoothStream(),
      abortSignal: runSignal,
    });
  } catch (error) {
    console.error("[chat] agent.stream failed:", error);
    releaseRun(streamId);
    await releaseChatRun(chatId, streamId);
    const message = formatStreamError(error);
    await markRunStatus("failed", message);
    return new Response(message, { status: 500 });
  }

  const firstByte = firstByteTimingTransform((ms) => {
    metrics.ttftMs = ms;
  });

  const streamContext = getStreamContext();
  const response = result.toUIMessageStreamResponse({
    // Surface any stream/generation failure as a readable message in the
    // client toast — and, if onFinish never runs, mark the empty assistant
    // row failed and release the run so the chat is never left blocked.
    onError: (error: unknown) => {
      console.error("[chat] stream error:", error);
      const message = formatStreamError(error);
      const aborted =
        message === "Stopped." ||
        (error instanceof Error && error.name === "AbortError");
      void (async () => {
        await markRunStatus(aborted ? "aborted" : "failed", message);
        releaseRun(streamId);
        await releaseChatRun(chatId, streamId);
      })();
      return message;
    },
    headers: {
      "X-Stream-Id": streamId,
      // Lets an unsaved New Chat client learn its fresh thread id and
      // navigate to it once the first response completes.
      "X-Chat-Id": chatId,
    },
    ...(streamContext
      ? {
          consumeSseStream: ({ stream }) => {
            // Store the TOKENIZED stream — PII is restored on the live
            // response path below and on GET resume, never before persisting.
            void streamContext.createNewResumableStream(streamId, () => stream);
          },
        }
      : {}),
  });

  // Persist the vault's prep-time mappings (encrypted) so a resumed stream
  // can restore tokens on read. onFinish overwrites this with the final
  // mappings once streaming registrations are complete.
  if (piiVault) {
    void persistVaultSnapshot(streamId, piiVault);
  }

  // Whenever a vault is active (and even when it has no new registrations this
  // request), wrap the response body with a transform that restores PII tokens
  // back to original values and strips any token restore() cannot resolve so a
  // placeholder never reaches the user. The SSE stream contains text like
  // "[CLAW_PERSON_NAME_542F] sent you a message" which we rewrite to
  // "John Doe sent you a message".
  if (piiVault && response.body) {
    const restored = response.body
      .pipeThrough(firstByte)
      .pipeThrough(createPIIRestoreTransform(piiVault));
    return new Response(restored, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  if (response.body) {
    const timed = response.body.pipeThrough(firstByte);
    return new Response(timed, {
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
    return new Response("Missing chatId", { status: 400 });
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

  // The stored stream is tokenized — restore PII on the way out using this
  // run's encrypted vault snapshot. Without a snapshot, serve as-is.
  let out: ReadableStream<string> = stream;
  try {
    const encrypted = await getVaultSnapshot(streamId);
    if (encrypted) {
      const snap: unknown = JSON.parse(await decrypt(encrypted));
      const vault = PIIVault.fromSnapshot(snap);
      if (vault) {
        out = stream.pipeThrough(createPIIRestoreStringTransform(vault));
      }
    }
  } catch (err) {
    console.error("[chat] resume restore failed — serving tokenized:", err);
  }

  return new Response(out.pipeThrough(new TextEncoderStream()), {
    headers: UI_MESSAGE_STREAM_HEADERS,
  });
}

export async function DELETE(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const userId = session.user.id;
  const url = new URL(request.url);
  const chatId = url.searchParams.get("chatId");
  const streamId = url.searchParams.get("streamId");

  if (!chatId || !streamId) {
    return new Response("Missing chatId or streamId", { status: 400 });
  }

  const chat = await db.chat.findUnique({
    where: { id: chatId },
    select: { id: true, instance: { select: { userId: true } } },
  });

  if (!chat || chat.instance.userId !== userId) {
    return new Response("Chat not found", { status: 404 });
  }

  // Only cancel the run this key actually points at.
  const active = await getStreamingMessage(chatId);
  if (active && active !== streamId) {
    return new Response(
      JSON.stringify({ error: "run_in_progress", activeStreamId: active }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  }

  console.info("[chat] run cancelled by user", { chatId, streamId });
  cancelRun(streamId);
  await releaseChatRun(chatId, streamId);
  await clearVaultSnapshot(streamId);

  // Mark exactly this run's assistant row cancelled — unless it already
  // reached a terminal state (completion raced the cancel).
  const messageId = await takeRunAssistant(streamId);
  if (messageId) {
    try {
      const row = await db.message.findUnique({
        where: { id: messageId },
        select: { runStatus: true },
      });
      if (row && !row.runStatus) {
        await db.message.update({
          where: { id: messageId },
          data: { runStatus: "cancelled" },
        });
      }
    } catch (err) {
      console.error("[chat] cancel marking failed:", err);
    }
  }

  return new Response(JSON.stringify({ ok: true, canBackground }), {
    headers: { "Content-Type": "application/json" },
  });
}
