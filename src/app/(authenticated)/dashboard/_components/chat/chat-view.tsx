"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Virtuoso } from "react-virtuoso";
import type { VirtuosoHandle } from "react-virtuoso";
import type { UIMessage } from "@ai-sdk/react";
import { Loader2 } from "lucide-react";
import { ErrorBoundary } from "~/components/core/error-boundary";
import { showErrorToast } from "~/components/core/toast-notifications";
import { useChatContext } from "../chat-context";
import { UserMessage } from "./user-message";
import { AssistantMessage } from "./assistant-message/assistant-message";
import { ThinkingIndicator } from "./assistant-message/thinking-indicator";
import { ChatInput } from "./chat-input";
import { useJarvisVoice } from "./use-jarvis-voice";
import { VoiceModeOverlay } from "./voice-mode-overlay";

const SAMPLE_PROMPTS = [
  "Summarize my emails for today",
  "What's on my calendar for tomorrow",
  "Catch me up on latest messages on Slack",
];

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return "What's keeping you up at this time?";
  if (hour < 12) return "Good morning. Let's get into it!";
  if (hour < 17) return "Good afternoon. What's the verdict?";
  if (hour < 22) return "Good evening. How can I help?";
  return "What's keeping you up at this time?";
}

const START_INDEX = 100_000;

export function ChatView() {
  const {
    sendMessage,
    sendVoiceMessage,
    stop,
    messages,
    status,
    setMessages,
    historyPageCount,
    fetchOlderMessages,
    hasOlderMessages,
    isFetchingOlderMessages,
    chatId,
  } = useChatContext();
  const isEmpty = messages.length === 0;

  const [firstItemIndex, setFirstItemIndex] = useState(START_INDEX);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Register scroll-to-bottom function in store so sidebar can trigger it
  const handleScrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      align: "end",
      behavior: "smooth",
    });
  }, []);

  const prevMessageCountRef = useRef(messages.length);
  const prevFirstIdRef = useRef<string | null>(null);

  // Track prepended older messages by comparing first-item identity and
  // count delta. Must be in useEffect (not render) to avoid state updates
  // during the render phase, which is a React anti-pattern.
  useEffect(() => {
    if (messages.length === 0) return;

    const currentFirstId = messages[0]!.id;
    const countDelta = messages.length - prevMessageCountRef.current;

    if (countDelta > 0 && prevFirstIdRef.current !== null && currentFirstId !== prevFirstIdRef.current) {
      setFirstItemIndex((prev) => prev - countDelta);
    }

    prevMessageCountRef.current = messages.length;
    prevFirstIdRef.current = currentFirstId;
  }, [messages]);

  // ── handleSend (text mode) — must be declared BEFORE useJarvisVoice ──
  const handleSend = useCallback(
    (text: string) => {
      const result = sendMessage(text);
      // Wait one frame for Virtuoso to render the new user message
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: "LAST",
          align: "start",
          behavior: "smooth",
        });
      });
      return result;
    },
    [sendMessage],
  );

  // ── handleVoiceSend — always passes isVoice:true via sendVoiceMessage ──
  const handleVoiceSend = useCallback(
    (text: string) => {
      const result = sendVoiceMessage(text);
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: "LAST",
          align: "start",
          behavior: "smooth",
        });
      });
      return result;
    },
    [sendVoiceMessage],
  );

      // We can't access initialMessages here anymore, but we can just let context handle history!
      // Wait, history fetching in context adds to the hook internally...
      // No, wait, context ONLY passes the hook down. The hook doesn't know about older messages.
      // If we prepend new older messages, we need them...
      // Let's just remove the history prepend logic from ChatView for a moment, or rather:
      // We should actually move this useEffect INTO useChatHook or InnerChatProvider if we want it to work correctly,
      // because initialMessages is not available here.
      // Ah! InnerChatProvider has initialMessages.
      // Let me just delete this useEffect block here and we will move it to InnerChatProvider.

  const handleStartReached = useCallback(() => {
    if (hasOlderMessages && !isFetchingOlderMessages) {
      void fetchOlderMessages();
    }
  }, [hasOlderMessages, isFetchingOlderMessages, fetchOlderMessages]);

  const isStreaming = status === "streaming" || status === "submitted";
  const lastMessage = messages[messages.length - 1];
  const isWaitingForAssistant = isStreaming && lastMessage?.role === "user";

  // Derive latest assistant text for TTS — UIMessage uses .parts, not .content
  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant");
  const latestAssistantText = lastAssistantMessage
    ? lastAssistantMessage.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { type: "text"; text: string }).text)
        .join("")
    : undefined;
  const latestAssistantMessageId = lastAssistantMessage?.id;

  const jarvis = useJarvisVoice({
    onSend: handleVoiceSend,
    isAgentStreaming: isStreaming,
    latestAssistantText,
    latestAssistantMessageId,
  });


  // Global drop blocker — prevent file drops anywhere in the chat area
  useEffect(() => {
    const handler = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
        showErrorToast("This model does not support image or file input");
      }
    };
    document.addEventListener("dragover", handler, { capture: true });
    document.addEventListener("drop", handler, { capture: true });
    return () => {
      document.removeEventListener("dragover", handler, { capture: true });
      document.removeEventListener("drop", handler, { capture: true });
    };
  }, []);

  return (
    <div
      className="relative flex h-full overflow-hidden"
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "none";
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        showErrorToast("This model does not support image or file input");
      }}
      onPaste={(e) => {
        // Block image paste at the container level (catches bubbles from textarea)
        const items = e.clipboardData?.items;
        if (items) {
          for (let i = 0; i < items.length; i++) {
            if (items[i]!.kind === "file") {
              e.preventDefault();
              showErrorToast("This model does not support image input");
              return;
            }
          }
        }
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-8">
            <div className="text-center">
              <h2 className="text-lg font-medium text-foreground/80">
                {getGreeting()}
              </h2>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {SAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => {
                    void handleSend(prompt);
                  }}
                  className="border-border text-muted-foreground hover:bg-accent hover:text-foreground rounded-full border px-4 py-2 text-[13px] transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>
            <div className="w-full max-w-3xl px-4">
              <ChatInput
                onSend={handleSend}
                onStop={stop}
                status={status}
                chatId={chatId}
                voice={{
                  whisperAvailable: jarvis.whisperAvailable,
                  onOpenVoiceMode: jarvis.openVoiceMode,
                }}
              />
            </div>
          </div>
        ) : (
          <>
            <div className="relative min-h-0 flex-1">
              <Virtuoso
                ref={virtuosoRef}
                data={messages}
                firstItemIndex={firstItemIndex}
                initialTopMostItemIndex={{ index: "LAST", align: "end" }}
                startReached={handleStartReached}
                atBottomThreshold={50}
                followOutput="smooth"
                increaseViewportBy={{ top: 200, bottom: 0 }}
                components={{
                  Header: () =>
                    isFetchingOlderMessages ? (
                      <div className="flex justify-center py-3">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : null,
                  Footer: () => (
                    <div className="pb-4 md:pb-6">
                      {isWaitingForAssistant && (
                        <div className="mx-auto w-full max-w-3xl px-4 pt-6 md:px-8">
                          <ThinkingIndicator />
                        </div>
                      )}
                    </div>
                  ),
                }}
                itemContent={(_index, message) =>
                  message.role === "user" ? (
                    <div className="mx-auto w-full max-w-3xl px-4 pt-6 md:px-8">
                      <ErrorBoundary
                        key={message.id}
                        fallback={
                          <p className="text-muted-foreground text-sm italic">
                            Failed to render message
                          </p>
                        }
                      >
                        <UserMessage message={message} />
                      </ErrorBoundary>
                    </div>
                  ) : (
                    <div className="mx-auto w-full max-w-3xl px-4 pt-6 md:px-8">
                      <ErrorBoundary
                        key={message.id}
                        fallback={
                          <p className="text-muted-foreground text-sm italic">
                            Failed to render message
                          </p>
                        }
                      >
                        <AssistantMessage
                          message={message}
                          status={message.id === lastMessage?.id ? status : "ready"}
                        />
                      </ErrorBoundary>
                    </div>
                  )
                }
                className="!overflow-y-auto"
              />
            </div>

            <ChatInput
              onSend={handleSend}
              onStop={stop}
              status={status}
              chatId={chatId}
              voice={{
                whisperAvailable: jarvis.whisperAvailable,
                onOpenVoiceMode: jarvis.openVoiceMode,
              }}
            />
          </>
        )}
      </div>

      {/* Jarvis Voice Mode Overlay */}
      <VoiceModeOverlay
        isOpen={jarvis.isVoiceModeOpen}
        jarvisState={jarvis.jarvisState}
        micPermission={jarvis.micPermission}
        volume={jarvis.volume}
        lastTranscription={jarvis.lastTranscription}
        error={jarvis.voiceError}
        onClose={jarvis.closeVoiceMode}
        onRequestMicPermission={jarvis.requestMicPermission}
      />
    </div>
  );
}
