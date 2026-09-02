"use client";

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { trpc } from "~/clients/trpc";
import { useInstanceId } from "~/hooks/use-instance-id";
import { showErrorToast } from "~/components/core/toast-notifications";

export function useChatHook({
  initialMessages,
  streamId,
  chatId,
}: {
  initialMessages: UIMessage[];
  streamId: string | null;
  chatId: string;
}) {
  const [instanceId] = useInstanceId();
  const utils = trpc.useUtils();
  const seededRef = useRef(false);
  const [isSeeded, setIsSeeded] = useState(false);

  const transport = useMemo(() => {
    return new DefaultChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest: ({ messages, body }) => ({
        body: {
          ...body,
          messages: messages.map((msg) => {
            const textParts = (msg.parts ?? []).filter(
              (p): p is { type: "text"; text: string } =>
                p.type === "text" &&
                typeof (p as { text?: string }).text === "string",
            );
            return {
              ...msg,
              parts: textParts.map((p) => ({
                ...p,
                text: p.text.replace(
                  /(?:^|\s)\/?[^\s]*\.(?:png|jpg|jpeg|gif|webp|svg|bmp|tiff)(?:\s|$)/gi,
                  " ",
                ),
              })),
            };
          }),
          instanceId,
          chatId,
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
        },
      }),
      prepareReconnectToStreamRequest: () => ({
        api: `/api/chat?streamId=${streamId}&chatId=${chatId}`,
      }),
    });
  }, [streamId, chatId, instanceId]);

  const chat = useChat({
    id: `chat-${chatId}`,
    transport,
    resume: streamId !== null,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onFinish: () => {
      void utils.nimitsJarvis.getHistory.invalidate();
      void utils.chats.list.invalidate();
    },
    onError: (error) => {
      void utils.nimitsJarvis.getHistory.invalidate();
      void utils.chats.list.invalidate();
      const msg = error.message || "An error occurred";
      if (msg.includes("image") || msg.includes("Cannot read")) {
        showErrorToast(
          "Image input is not supported. Please remove any attached images and try again.",
        );
      } else {
        showErrorToast(msg);
      }
    },
  });

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

  // Standard text-mode send — isVoice always false, fs mode passed through.
  const sendMessage = useCallback(
    (text: string, fsAccessMode?: "read-only" | "full") => {
      void sendMessageRef.current(
        { text },
        { body: { isVoice: false, fsAccessMode } },
      );
    },
    [],
  );

  // Voice-mode send — isVoice is always true. Rides the sendMessage OPTIONS
  // body (2nd arg) so prepareSendMessagesRequest's `body` spread picks it up.
  const sendVoiceMessage = useCallback((text: string) => {
    void sendMessageRef.current({ text }, { body: { isVoice: true } });
  }, []);

  const stopRef = useRef(chat.stop);
  stopRef.current = chat.stop;

  const stableStop = useCallback(() => {
    void stopRef.current();
  }, []);

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
