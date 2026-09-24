"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { trpc } from "~/clients/trpc";
import { useChatHook } from "./use-chat-hook";
import type { UIMessage } from "@ai-sdk/react";
import { NimitsJarvisChatSkeleton } from "./chat/nimits-jarvis-chat.skeleton";
import { ErrorDisplay } from "~/components/core/error-display";
import { Button } from "~/components/ui/button";
import { useInstanceId } from "~/hooks/use-instance-id";
import { useChatId } from "~/hooks/use-chat-id";
import { DEFAULT_TIMEZONE } from "~/lib/timezone";

type ChatContextType = ReturnType<typeof useChatHook> & {
  chatId: string | null;
  historyPageCount: number;
  fetchOlderMessages: () => void;
  hasOlderMessages: boolean;
  isFetchingOlderMessages: boolean;
  /** User's IANA timezone (for timezone-local message timestamps). */
  timezone: string;
};

const ChatContext = createContext<ChatContextType | null>(null);

export function ChatProvider({
  children,
  chatId,
}: {
  children: ReactNode;
  chatId: string | null;
}) {
  const [instanceId] = useInstanceId();
  const [, setChatId] = useChatId();

  // Unsaved New Chat (chatId null): no thread exists, so history/streaming
  // queries stay disabled and the provider seeds an empty conversation.
  const historyQuery = trpc.nimitsJarvis.getHistory.useInfiniteQuery(
    { limit: 10, instanceId, chatId: chatId ?? undefined },
    {
      enabled: chatId !== null,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    },
  );

  const streamingQuery = trpc.nimitsJarvis.getStreamingMessage.useQuery(
    { instanceId, chatId: chatId ?? undefined },
    {
      enabled: chatId !== null,
      refetchOnWindowFocus: "always",
      staleTime: 5_000,
      retry: (failureCount, error) => {
        const code = (error as { data?: { code?: string } })?.data?.code;
        if (code === "NOT_FOUND" || code === "FORBIDDEN") return false;
        return failureCount < 3;
      },
    },
  );

  const instanceQuery = trpc.nimitsJarvis.getInstance.useQuery({ instanceId });

  const hasFatalHistoryError = !!historyQuery.error;
  const historyErrorCode = (
    historyQuery.error as { data?: { code?: string } } | null
  )?.data?.code;
  // Unknown/deleted thread: the thread is gone, so retrying the same id can
  // never succeed — offer the way out instead of a dead-end error screen.
  const isUnknownChat =
    historyErrorCode === "NOT_FOUND" || historyErrorCode === "FORBIDDEN";
  const hasFatalStreamingError = (() => {
    if (!streamingQuery.error) return false;
    const code = (streamingQuery.error as { data?: { code?: string } })?.data?.code;
    // NOT_FOUND/FORBIDDEN from streaming poll is non-fatal (no active stream yet or stale chat)
    if (code === "NOT_FOUND" || code === "FORBIDDEN") return false;
    return true;
  })();

  if (hasFatalHistoryError || hasFatalStreamingError) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8">
        <ErrorDisplay
          message={
            isUnknownChat
              ? "This chat no longer exists"
              : "Failed to load chat history"
          }
          retryText="Retry"
          onRetry={() => {
            void historyQuery.refetch();
            void streamingQuery.refetch();
          }}
        />
        {isUnknownChat && (
          <Button variant="outline" size="sm" onClick={() => setChatId("new")}>
            Back to New Chat
          </Button>
        )}
      </div>
    );
  }

  if (!historyQuery.data || streamingQuery.isLoading) {
    if (chatId !== null) {
      return (
        <div className="flex h-full w-full flex-col">
          <NimitsJarvisChatSkeleton />
        </div>
      );
    }
  }

  const pages = historyQuery.data?.pages ?? [];
  const allHistoryMessages =
    chatId === null ? [] : [...pages].reverse().flatMap((p) => p.messages);

  const streamId =
    chatId === null ? null : (streamingQuery.data?.messageId ?? null);
  const hasActiveStream = streamId !== null;

  const initialMessages: UIMessage[] = allHistoryMessages.map((msg) => {
    const rawParts = (msg.content as UIMessage["parts"]) ?? [];
    let parts = rawParts;
    const runStatus =
      (msg as { runStatus?: string | null }).runStatus ?? null;
    // Normalize interrupted history: any tool still waiting on an output when
    // the run is terminal (or there is no active stream) can never complete —
    // mark it terminal so spinners stop and auto-resend stays off. Skip while
    // a live stream may still deliver the missing output.
    const shouldNormalize =
      msg.role === "assistant" && (runStatus !== null || !hasActiveStream);
    if (shouldNormalize) {
      parts = parts.map((part) => {
        const p = part as { type: string; state?: string };
        const isTool =
          p.type === "dynamic-tool" ||
          (typeof p.type === "string" && p.type.startsWith("tool-"));
        if (
          isTool &&
          (p.state === "input-streaming" || p.state === "input-available")
        ) {
          return {
            ...part,
            state: "output-error",
            errorText: "Run interrupted",
          } as UIMessage["parts"][number];
        }
        return part;
      });
      // Interrupted run that never wrote content — show a terminal notice
      // instead of a blank assistant bubble.
      if (parts.length === 0) {
        if (runStatus !== null && runStatus !== "completed") {
          parts = [
            {
              type: "text",
              text:
                runStatus === "timed_out"
                  ? "Run timed out before any output was saved."
                  : `Run ${runStatus} before any output was saved.`,
            },
          ];
        } else if (runStatus === null && !hasActiveStream) {
          // Pre-fix rows died without ever writing runStatus or content.
          parts = [
            {
              type: "text",
              text: "Run interrupted before any output was saved.",
            },
          ];
        }
      }
    }
    return {
      id: msg.id,
      role: msg.role,
      parts: [
        ...parts,
        // Sent images render from the same-origin serving route (img-src 'self'
        // covers them — no blob: data: URLs needed). Array order is the index.
        ...((msg as { attachments?: Array<{ id: string }> }).attachments ?? []).map(
          (a) => ({
            type: "file" as const,
            mediaType: "image/webp",
            url: `/api/attachments/${a.id}?variant=thumb`,
          }),
        ),
      ],
      // Carry the DB timestamp through the UI so hover timestamps work for
      // loaded history. This metadata is client-only and never sent to the LLM.
      metadata: {
        createdAt: msg.createdAt.toISOString(),
        ...(parts.some(
          (p) =>
            (p as { state?: string }).state === "output-error" &&
            (p as { errorText?: string }).errorText === "Run interrupted",
        )
          ? { interrupted: true }
          : {}),
      },
    };
  });

  const timezone = instanceQuery.data?.timezone ?? DEFAULT_TIMEZONE;

  return (
    <InnerChatProvider
      initialMessages={initialMessages}
      streamId={streamId}
      historyPageCount={pages.length}
      fetchOlderMessages={
        chatId === null
          ? () => undefined
          : () => void historyQuery.fetchNextPage()
      }
      hasOlderMessages={historyQuery.hasNextPage ?? false}
      isFetchingOlderMessages={historyQuery.isFetchingNextPage}
      chatId={chatId}
      timezone={timezone}
    >
      {children}
    </InnerChatProvider>
  );
}

function InnerChatProvider({
  children,
  initialMessages,
  streamId,
  historyPageCount,
  fetchOlderMessages,
  hasOlderMessages,
  isFetchingOlderMessages,
  chatId,
  timezone,
}: {
  children: ReactNode;
  initialMessages: UIMessage[];
  streamId: string | null;
  historyPageCount: number;
  fetchOlderMessages: () => void;
  hasOlderMessages: boolean;
  isFetchingOlderMessages: boolean;
  chatId: string | null;
  timezone: string;
}) {
  const chatHook = useChatHook({ initialMessages, streamId, chatId });

  const pageCountRef = useRef(historyPageCount);
  useEffect(() => {
    if (historyPageCount <= pageCountRef.current) {
      pageCountRef.current = historyPageCount;
      return;
    }
    chatHook.setMessages((current) => {
      const currentIds = new Set(current.map((m) => m.id));
      const newOlder = initialMessages.filter((m) => !currentIds.has(m.id));
      if (newOlder.length === 0) return current;
      return [...newOlder, ...current];
    });
    pageCountRef.current = historyPageCount;
  }, [historyPageCount, initialMessages, chatHook.setMessages]);

  return (
    <ChatContext.Provider
      value={{
        ...chatHook,
        chatId,
        historyPageCount,
        fetchOlderMessages,
        hasOlderMessages,
        isFetchingOlderMessages,
        timezone,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChatContext() {
  const ctx = useContext(ChatContext);
  if (!ctx)
    throw new Error("useChatContext must be used within a ChatProvider");
  return ctx;
}
