"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Virtuoso } from "react-virtuoso";
import type { VirtuosoHandle } from "react-virtuoso";
import { Loader2 } from "lucide-react";
import { ErrorBoundary } from "~/components/core/error-boundary";
import { useChatContext } from "../chat-context";
import { UserMessage } from "./user-message";
import { AssistantMessage } from "./assistant-message/assistant-message";
import { ThinkingIndicator } from "./assistant-message/thinking-indicator";
import { ChatInput } from "./chat-input";
import { InlineVoiceBar } from "./inline-voice-bar";
import { useVoiceSession } from "./use-voice-session";
import { useInstanceId } from "~/hooks/use-instance-id";
import { useChatId } from "~/hooks/use-chat-id";
import { trpc } from "~/clients/trpc";
import { useAttachments } from "./use-attachments";

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
    hasOlderMessages,
    isFetchingOlderMessages,
    fetchOlderMessages,
    chatId,
    setMessages,
  } = useChatContext();
  const isEmpty = messages.length === 0;
  const [firstItemIndex, setFirstItemIndex] = useState(START_INDEX);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const prevMessageCountRef = useRef(messages.length);
  const prevFirstIdRef = useRef<string | null>(null);

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

  // ── Skill pins (Part IV) — per-message, never sticky ──
  const [pinnedSkills, setPinnedSkills] = useState<string[]>([]);
  useEffect(() => { setPinnedSkills([]); }, [chatId]);
  const [, setUrlChatId] = useChatId();
  const attachments = useAttachments();
  useEffect(() => { attachments.clear(); }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleChatCreated = useCallback((id: string) => {
    setUrlChatId(id);
  }, [setUrlChatId]);
  const togglePin = useCallback((slug: string) => {
    setPinnedSkills((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
  }, []);
  const clearPins = useCallback(() => setPinnedSkills([]), []);

  const handleSend = useCallback(
    (text: string, fsAccessMode?: "read-only" | "full", pins?: string[], attachmentIds?: string[]) => {
      // Snapshot ready tray thumbs before ChatInput clears the tray — merged
      // into the optimistic user message so sent images are visible while the
      // response streams (history mapping covers reloads). Idempotent by URL.
      const thumbs = attachments.items
        .filter((it) => it.status === "ready" && (it.thumbUrl ?? it.previewUrl))
        .map((it) => it.thumbUrl ?? it.previewUrl);
      const result = sendMessage(text, fsAccessMode, pins, attachmentIds);
      if (thumbs.length > 0) {
        const fileParts = thumbs.map((url) => ({ type: "file" as const, mediaType: "image/webp", url }));
        const merge = () =>
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== "user") return prev;
            const have = new Set(
              last.parts
                .filter((p) => p.type === "file")
                .map((p) => (p as { url?: string }).url),
            );
            const fresh = fileParts.filter((fp) => !have.has(fp.url));
            if (fresh.length === 0) return prev;
            return [...prev.slice(0, -1), { ...last, parts: [...last.parts, ...fresh] }];
          });
        requestAnimationFrame(merge);
        setTimeout(merge, 600);
      }
      // Pins are per-message: clear on send (and on chat switch below).
      setPinnedSkills([]);
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" });
      });
      return result;
    },
    [sendMessage, setMessages, setPinnedSkills, attachments],
  );

  const handleVoiceSend = useCallback(
    (text: string) => {
      const result = sendVoiceMessage(text);
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" });
      });
      return result;
    },
    [sendVoiceMessage],
  );

  const handleStartReached = useCallback(() => {
    if (hasOlderMessages && !isFetchingOlderMessages) void fetchOlderMessages();
  }, [hasOlderMessages, isFetchingOlderMessages, fetchOlderMessages]);

  const isStreaming = status === "streaming" || status === "submitted";
  const lastMessage = messages[messages.length - 1];
  const isWaitingForAssistant = isStreaming && lastMessage?.role === "user";

  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant");
  const latestAssistantText = lastAssistantMessage
    ? lastAssistantMessage.parts.filter((p) => p.type === "text").map((p) => (p as { type: "text"; text: string }).text).join("")
    : undefined;
  const latestAssistantMessageId = lastAssistantMessage?.id;

  const [instanceIdForVoice] = useInstanceId();
  const { data: instanceData, isFetched: instanceFetched } = trpc.nimitsJarvis.getInstance.useQuery({ instanceId: instanceIdForVoice });
  const voiceInstance = instanceData?.instance as any;

  // ── Filesystem access mode (Phase A) — per-message, never persisted ──
  const [fsMode, setFsMode] = useState<"read-only" | "full">("read-only");
  // Layer 2 rule: reset to read-only on every new chat.
  useEffect(() => { setFsMode("read-only"); }, [chatId]);

  // --- Claude-exact inline voice session (scratch) — replaces old overlay hook ---
  const voice = useVoiceSession({
    instanceId: instanceIdForVoice,
    sttModel: voiceInstance?.sttModel ?? "small",
    ttsVoice: voiceInstance?.ttsVoice ?? "s2.1-pro-free",
    ttsProvider: voiceInstance?.ttsProvider ?? "fish-audio",
    voiceStyle: voiceInstance?.voiceStyle ?? "",
    onSend: handleVoiceSend,
    isAgentStreaming: isStreaming,
    latestAssistantText,
    latestAssistantMessageId,
  });

  // Composer owns paste/drop now (tray + upload). Document-level drops
  // outside the composer are still prevented so the browser doesn't
  // navigate away — but no longer toast as unsupported.
  useEffect(() => {
    const handler = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
    };
    document.addEventListener("dragover", handler, { capture: true });
    document.addEventListener("drop", handler, { capture: true });
    return () => {
      document.removeEventListener("dragover", handler, { capture: true });
      document.removeEventListener("drop", handler, { capture: true });
    };
  }, []);

  const showInlineVoice = voice.isVoiceActive;
  // Stop = full stop: cancels LLM + TTS + mic AND exits voice → text mode
  const handleVoiceStop = useCallback(() => {
    voice.stopAll();
    stop();
    voice.closeVoice();
  }, [voice, stop]);

  return (
    <div className="relative flex h-full overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-8">
            <div className="text-center">
              <h2 className="text-lg font-medium text-foreground/80">{getGreeting()}</h2>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {SAMPLE_PROMPTS.map((prompt) => (
                <button key={prompt} onClick={() => void handleSend(prompt)} className="rounded-full border border-border px-4 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                  {prompt}
                </button>
              ))}
            </div>
            <div className="w-full max-w-3xl px-4">
              {showInlineVoice ? (
                <InlineVoiceBar state={voice.state} volume={voice.volume} liveTranscript={voice.liveTranscript} error={voice.voiceError} onStop={handleVoiceStop} />
              ) : (
                <ChatInput onSend={handleSend} onStop={stop} status={status} chatId={chatId ?? ""} attachments={attachments} onChatCreated={handleChatCreated} voice={{ whisperAvailable: voice.whisperAvailable, onOpenVoiceMode: voice.openVoice }} fsAccess={{ mode: fsMode, onModeChange: setFsMode, fsWriteAllowed: voiceInstance?.fsWriteAllowed ?? false, instanceResolved: instanceFetched }} skillsPin={{ pinned: pinnedSkills, onToggle: togglePin, onClear: clearPins }} />
              )}
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
                  Header: () => (isFetchingOlderMessages ? <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div> : null),
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
                      <ErrorBoundary key={message.id} fallback={<p className="text-sm italic text-muted-foreground">Failed to render message</p>}>
                        <UserMessage message={message} />
                      </ErrorBoundary>
                    </div>
                  ) : (
                    <div className="mx-auto w-full max-w-3xl px-4 pt-6 md:px-8">
                      <ErrorBoundary key={message.id} fallback={<p className="text-sm italic text-muted-foreground">Failed to render message</p>}>
                        <AssistantMessage message={message} status={message.id === lastMessage?.id ? status : "ready"} />
                      </ErrorBoundary>
                    </div>
                  )
                }
                className="!overflow-y-auto"
              />
            </div>

            {showInlineVoice ? (
              <InlineVoiceBar state={voice.state} volume={voice.volume} liveTranscript={voice.liveTranscript} error={voice.voiceError} onStop={handleVoiceStop} />
            ) : (
              <ChatInput onSend={handleSend} onStop={stop} status={status} chatId={chatId ?? ""} attachments={attachments} onChatCreated={handleChatCreated} voice={{ whisperAvailable: voice.whisperAvailable, onOpenVoiceMode: voice.openVoice }} fsAccess={{ mode: fsMode, onModeChange: setFsMode, fsWriteAllowed: voiceInstance?.fsWriteAllowed ?? false, instanceResolved: instanceFetched }} skillsPin={{ pinned: pinnedSkills, onToggle: togglePin, onClear: clearPins }} />
            )}
          </>
        )}
      </div>

      {/* Old overlay kept but not rendered in Claude-exact inline mode */}
    </div>
  );
}
