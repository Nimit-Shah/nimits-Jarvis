"use client";

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { trpc } from "~/clients/trpc";
import { useInstanceId } from "~/hooks/use-instance-id";
import { useChatId } from "~/hooks/use-chat-id";
import { showErrorToast } from "~/components/core/toast-notifications";

/**
 * Parses a `409 run_in_progress` transport error body.
 * Returns null when the error is anything else.
 */
function parseRunInProgress(
  errorMessage: string,
): { activeStreamId: string | null; chatId: string | null } | null {
  try {
    const parsed = JSON.parse(errorMessage) as {
      error?: unknown;
      activeStreamId?: unknown;
      chatId?: unknown;
    };
    if (parsed.error !== "run_in_progress") return null;
    return {
      activeStreamId:
        typeof parsed.activeStreamId === "string"
          ? parsed.activeStreamId
          : null,
      chatId: typeof parsed.chatId === "string" ? parsed.chatId : null,
    };
  } catch {
    return null;
  }
}

export function useChatHook({
  initialMessages,
  streamId,
  chatId,
}: {
  initialMessages: UIMessage[];
  streamId: string | null;
  chatId: string | null;
}) {
  const [instanceId] = useInstanceId();
  const [, setUrlChatId] = useChatId();
  const utils = trpc.useUtils();
  const seededRef = useRef(false);
  const [isSeeded, setIsSeeded] = useState(false);

  // Latest known live stream for this chat — the query value can lag behind
  // a 409 response, so the transport reads through this ref and the 409
  // handler can point it at the winning stream before resuming.
  const liveStreamIdRef = useRef<string | null>(streamId);
  liveStreamIdRef.current = streamId;

  type ChatApi = Pick<
    ReturnType<typeof useChat>,
    "setMessages" | "clearError" | "resumeStream"
  >;
  const chatApiRef = useRef<ChatApi | null>(null);

  // Unsaved New Chat (chatId null): the thread is created lazily by the
  // server on the first submit. These refs learn the fresh ids from the
  // first response (X-Chat-Id / X-Stream-Id headers, or a 409 body) so the
  // client can surface the sidebar entry immediately and navigate to the
  // real thread when the first response completes.
  const pendingChatIdRef = useRef<string | null>(null);
  const lastStreamIdRef = useRef<string | null>(null);

  const transport = useMemo(() => {
    return new DefaultChatTransport({
      api: "/api/chat",
      fetch: async (url, init) => {
        const res = await globalThis.fetch(url, init);
        const createdChatId = res.headers.get("X-Chat-Id");
        if (createdChatId) {
          pendingChatIdRef.current = createdChatId;
          // The thread now exists — surface its sidebar entry right away.
          void utils.chats.list.invalidate();
        }
        const streamIdHeader = res.headers.get("X-Stream-Id");
        if (streamIdHeader) {
          lastStreamIdRef.current = streamIdHeader;
        }
        return res;
      },
      prepareSendMessagesRequest: ({ messages, body }) => ({
        body: {
          ...body,
          messages: messages.map((msg) => {
            const textParts = (msg.parts ?? []).filter(
              (p): p is { type: "text"; text: string } =>
                p.type === "text" &&
                typeof (p as { text?: string }).text === "string",
            );
            return { ...msg, parts: textParts };
          }),
          instanceId,
          // Unsaved New Chat posts without a chatId — the server creates
          // the thread on the first submitted message. undefined (not null)
          // so the key is dropped from the JSON body.
          chatId: chatId ?? undefined,
          // isVoice rides the sendMessage options body (2nd arg), NOT message
          // metadata — requestMetadata/message metadata never reached the
          // server before, so VOICE_MODE_GUIDELINES never applied.
          isVoice:
            (body as { isVoice?: boolean } | undefined)?.isVoice ?? false,
          // Per-message filesystem access mode — same transport as isVoice.
          // Clamped server-side; see agent/setup.ts resolveFsMode.
          fsAccessMode:
            (body as { fsAccessMode?: "read-only" | "full" } | undefined)
              ?.fsAccessMode ?? "read-only",
          // Skills pinned from the composer menu — per-message, never sticky.
          // Validated server-side; see agent/setup.ts pinnedSkills.
          pinnedSkills:
            (body as { pinnedSkills?: string[] } | undefined)?.pinnedSkills,
          // Image attachment ids for this turn — validated server-side.
          attachmentIds:
            (body as { attachmentIds?: string[] } | undefined)?.attachmentIds,
        },
      }),
      prepareReconnectToStreamRequest: () => ({
        api: `/api/chat?streamId=${liveStreamIdRef.current}&chatId=${pendingChatIdRef.current ?? chatId ?? ""}`,
      }),
    });
  }, [streamId, chatId, instanceId]);

  const chat = useChat({
    id: `chat-${chatId ?? "new"}`,
    transport,
    resume: streamId !== null,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onFinish: () => {
      void utils.nimitsJarvis.getHistory.invalidate();
      void utils.chats.list.invalidate();
      // First message of an unsaved New Chat completed: the thread now
      // exists — navigate to it so the URL, history, and sidebar settle on
      // the real conversation. The provider remounts with persisted rows.
      if (chatId === null && pendingChatIdRef.current) {
        const createdId = pendingChatIdRef.current;
        pendingChatIdRef.current = null;
        setUrlChatId(createdId);
      }
    },
    onError: (error) => {
      // Lost the in-flight race (or double-fired): attach to the winning
      // run instead of erroring. The server wrote no rows for this submit,
      // so drop the optimistic user message and resume the live stream.
      const duplicate = parseRunInProgress(error.message);
      if (duplicate) {
        if (duplicate.activeStreamId) {
          liveStreamIdRef.current = duplicate.activeStreamId;
        }
        if (duplicate.chatId) {
          pendingChatIdRef.current = duplicate.chatId;
          void utils.chats.list.invalidate();
        }
        chatApiRef.current?.clearError();
        chatApiRef.current?.setMessages((msgs) =>
          msgs.length > 0 && msgs[msgs.length - 1]?.role === "user"
            ? msgs.slice(0, -1)
            : msgs,
        );
        if (duplicate.activeStreamId) {
          void chatApiRef.current?.resumeStream();
        }
        void utils.nimitsJarvis.getHistory.invalidate();
        void utils.chats.list.invalidate();
        return;
      }
      void utils.nimitsJarvis.getHistory.invalidate();
      void utils.chats.list.invalidate();
      const msg = error.message || "An error occurred";
      showErrorToast(msg);
    },
  });

  chatApiRef.current = {
    setMessages: chat.setMessages,
    clearError: chat.clearError,
    resumeStream: chat.resumeStream,
  };

  // Stable per-message creation timestamps for live/streamed messages. History
  // messages carry createdAt in metadata from getHistory; anything else (a
  // freshly sent user message, an in-flight assistant reply) gets stamped once
  // on first appearance so hover timestamps are stable across re-renders.
  const liveTimestampsRef = useRef<Map<string, number>>(new Map());

  const stampedMessages = useMemo(() => {
    return chat.messages.map((msg) => {
      const existing = (msg.metadata as { createdAt?: string } | undefined)
        ?.createdAt;
      if (existing) {
        return msg;
      }
      const now = Date.now();
      const stampedAt = liveTimestampsRef.current.get(msg.id) ?? now;
      liveTimestampsRef.current.set(msg.id, stampedAt);
      return {
        ...msg,
        metadata: {
          ...(msg.metadata as object | undefined),
          createdAt: new Date(stampedAt).toISOString(),
        },
      };
    });
  }, [chat.messages]);

  // Seed initial messages once on mount. Never pass `messages` as a controlled
  // prop to useChat - it resets internal state on every render, which causes a
  // scroll loop when combined with Virtuoso's followOutput during streaming.
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (initialMessages.length > 0) {
      chat.setMessages(initialMessages);
    }
    setIsSeeded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once on mount only
  }, []);

  const sendMessageRef = useRef(chat.sendMessage);
  sendMessageRef.current = chat.sendMessage;

  // Standard text-mode send — isVoice always false, fs mode + skill pins
  // passed through. Each send carries a fresh idempotency key so a
  // retried/double-fired submit attaches to the first run instead of
  // starting a second one.
  const sendMessage = useCallback(
    (
      text: string,
      fsAccessMode?: "read-only" | "full",
      pinnedSkills?: string[],
      attachmentIds?: string[],
    ) => {
      void sendMessageRef.current(
        { text },
        {
          body: {
            isVoice: false,
            fsAccessMode,
            pinnedSkills:
              pinnedSkills && pinnedSkills.length > 0 ? pinnedSkills : undefined,
            attachmentIds:
              attachmentIds && attachmentIds.length > 0 ? attachmentIds : undefined,
            idempotencyKey: crypto.randomUUID(),
          },
        },
      );
    },
    [],
  );

  // Voice-mode send — isVoice is always true. Rides the sendMessage OPTIONS
  // body (2nd arg) so prepareSendMessagesRequest's `body` spread picks it up.
  const sendVoiceMessage = useCallback((text: string) => {
    void sendMessageRef.current(
      { text },
      { body: { isVoice: true, idempotencyKey: crypto.randomUUID() } },
    );
  }, []);

  const stopRef = useRef(chat.stop);
  stopRef.current = chat.stop;

  const stableStop = useCallback(() => {
    const sid = liveStreamIdRef.current ?? lastStreamIdRef.current;
    const stopChatId = chatId ?? pendingChatIdRef.current;
    // Explicit server cancel first: on background-capable runtimes the run
    // survives a dropped connection, so aborting the fetch alone would only
    // hide it. DELETE is idempotent — safe to call with a stale streamId.
    if (sid && stopChatId) {
      const url = `/api/chat?chatId=${encodeURIComponent(stopChatId)}&streamId=${encodeURIComponent(sid)}`;
      void fetch(url, { method: "DELETE" }).catch((err: unknown) =>
        console.error("[chat] cancel request failed:", err),
      );
    }
    void stopRef.current();
  }, [chatId]);

  // Approval-card flow (Phase B): supply a tool result for a no-execute tool
  // (fs_edit/fs_write/…) after the operator clicks Approve/Reject. Stable ref
  // so the card can call it without prop-drilling through every message.
  const addToolOutputRef = useRef(chat.addToolOutput);
  addToolOutputRef.current = chat.addToolOutput;
  const addToolOutput = useCallback(
    (
      args: Parameters<typeof chat.addToolOutput>[0],
    ): ReturnType<typeof chat.addToolOutput> => {
      return addToolOutputRef.current(args);
    },
    [],
  );

  return {
    sendMessage,
    sendVoiceMessage,
    stop: stableStop,
    addToolOutput,
    // Return initialMessages until seeded to avoid flash of empty state
    messages: isSeeded ? stampedMessages : initialMessages,
    status: chat.status,
    error: chat.error,
    setMessages: chat.setMessages,
  };
}
