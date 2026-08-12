"use client";

import { useEffect, useState, useRef } from "react";
import { trpc } from "~/clients/trpc";
import { useChatId } from "~/hooks/use-chat-id";
import { useInstanceId } from "~/hooks/use-instance-id";
import { ChatProvider } from "../chat-context";
import { ChatView } from "./chat-view";
import { NimitsJarvisChatSkeleton } from "./nimits-jarvis-chat.skeleton";

function ChatWithProvider({ chatId }: { chatId: string }) {
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

    if (!urlChatId || justLoaded) {
      const first = chats[0]!;
      setChatId(first.id);
      setResolvedId(first.id);
    }
  }, [chats, urlChatId, setChatId]);

  if (!resolvedId) {
    return <NimitsJarvisChatSkeleton />;
  }

  return <ChatWithProvider key={resolvedId} chatId={resolvedId} />;
}
