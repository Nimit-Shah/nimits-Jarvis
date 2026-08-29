"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { trpc } from "~/clients/trpc";
import { useChatHook } from "./use-chat-hook";
import type { UIMessage } from "@ai-sdk/react";
import { NimitsJarvisChatSkeleton } from "./chat/nimits-jarvis-chat.skeleton";
import { ErrorDisplay } from "~/components/core/error-display";
import { useInstanceId } from "~/hooks/use-instance-id";
import { DEFAULT_TIMEZONE } from "~/lib/timezone";

type ChatContextType = ReturnType<typeof useChatHook> & {
  chatId: string;
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
  chatId: string;
}) {
  const [instanceId] = useInstanceId();

  const historyQuery = trpc.nimitsJarvis.getHistory.useInfiniteQuery(
    { limit: 10, instanceId, chatId },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    },
  );

  const streamingQuery = trpc.nimitsJarvis.getStreamingMessage.useQuery(
    { instanceId, chatId },
    {
      enabled: !!chatId || !!instanceId,
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
  const hasFatalStreamingError = (() => {
    if (!streamingQuery.error) return false;
    const code = (streamingQuery.error as { data?: { code?: string } })?.data?.code;
    // NOT_FOUND/FORBIDDEN from streaming poll is non-fatal (no active stream yet or stale chat)
    if (code === "NOT_FOUND" || code === "FORBIDDEN") return false;
    return true;
  })();

  if (hasFatalHistoryError || hasFatalStreamingError) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center p-8">
        <ErrorDisplay
          message="Failed to load chat history"
          retryText="Retry"
          onRetry={() => {
            void historyQuery.refetch();
            void streamingQuery.refetch();
          }}
        />
      </div>
    );
  }

  if (!historyQuery.data || streamingQuery.isLoading) {
    return (
      <div className="flex h-full w-full flex-col">
        <NimitsJarvisChatSkeleton />
      </div>
    );
  }

  const pages = historyQuery.data.pages;
  const allHistoryMessages = [...pages].reverse().flatMap((p) => p.messages);

  const initialMessages: UIMessage[] = allHistoryMessages.map((msg) => ({
    id: msg.id,
    role: msg.role,
    parts: msg.content as UIMessage["parts"],
    // Carry the DB timestamp through the UI so hover timestamps work for
    // loaded history. This metadata is client-only and never sent to the LLM.
    metadata: { createdAt: msg.createdAt.toISOString() },
  }));

  const streamId = streamingQuery.data?.messageId ?? null;
  const timezone = instanceQuery.data?.timezone ?? DEFAULT_TIMEZONE;

  return (
    <InnerChatProvider
      initialMessages={initialMessages}
      streamId={streamId}
      historyPageCount={pages.length}
      fetchOlderMessages={() => void historyQuery.fetchNextPage()}
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
  chatId: string;
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
