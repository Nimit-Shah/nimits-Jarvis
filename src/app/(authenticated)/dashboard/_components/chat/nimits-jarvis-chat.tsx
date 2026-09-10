"use client";

import { useEffect, useState, useRef } from "react";
import { trpc } from "~/clients/trpc";
import { useChatId } from "~/hooks/use-chat-id";
import { useInstanceId } from "~/hooks/use-instance-id";
import { ChatProvider } from "../chat-context";
import { ChatView } from "./chat-view";
import { NimitsJarvisChatSkeleton } from "./nimits-jarvis-chat.skeleton";

function ChatWithProvider({ chatId }: { chatId: string | null }) {
  return (
    <ChatProvider chatId={chatId}>
      <ChatView />
    </ChatProvider>
  );
}

export function NimitsJarvisChat() {
  const [instanceId] = useInstanceId();
  const [urlChatId, setChatId] = useChatId();
  const [resolvedId, setResolvedId] = useState<string | null>(null);

  const { data: chats } = trpc.chats.list.useQuery(
    { instanceId },
    { staleTime: 30_000 },
  );

  const prevChatsLengthRef = useRef(0);

  useEffect(() => {
    if (!chats || chats.length === 0) return;

    const currentLength = chats.length;
    const justLoaded = prevChatsLengthRef.current === 0 && currentLength > 0;
    prevChatsLengthRef.current = currentLength;

    if (urlChatId && chats.some((c) => c.id === urlChatId)) {
      setResolvedId(urlChatId);
      return;
    }

    if (urlChatId && urlChatId !== "new") {
      // Stale/unknown id (deleted thread, resurrected storage value, bad
      // link): converge to the unsaved New Chat state instead of mounting a
      // provider that can only 404. setChatId also overwrites the stored id.
      setChatId("new");
      return;
    }

    if (!urlChatId || justLoaded) {
      const first = chats[0]!;
      setChatId(first.id);
      setResolvedId(first.id);
    }
  }, [chats, urlChatId, setChatId]);

  if (!resolvedId) {
    return <NimitsJarvisChatSkeleton />;
  }

  // Explicit unsaved state (?chat=new): no thread exists yet. The provider
  // renders the existing empty start terminal and the thread is created
  // lazily by the server on the first submitted message — never before.
  if (urlChatId === "new") {
    return <ChatWithProvider key="new" chatId={null} />;
  }

  return <ChatWithProvider key={resolvedId} chatId={resolvedId} />;
}
