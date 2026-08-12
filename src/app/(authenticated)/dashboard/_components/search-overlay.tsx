"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Search, MessageSquare, X, Loader2 } from "lucide-react";
import { trpc } from "~/clients/trpc";
import { cn } from "~/lib/utils";
import { DEFAULT_TIMEZONE, formatDateTimeLocal } from "~/lib/timezone";

interface SearchOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  instanceId: string;
  onSelectChat: (chatId: string) => void;
}

interface SearchResult {
  messageId: string;
  chatId: string;
  preview: string;
  createdAt: string;
}

export function SearchOverlay({
  isOpen,
  onClose,
  instanceId,
  onSelectChat,
}: SearchOverlayProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const { data: chatList } = trpc.chats.list.useQuery(
    { instanceId },
    { enabled: isOpen },
  );

  const { data: searchResults, isLoading } = trpc.chats.search.useQuery(
    { instanceId, query, limit: 10 },
    { enabled: isOpen && query.length >= 2 },
  );

  const { data: instanceData } = trpc.nimitsJarvis.getInstance.useQuery(
    { instanceId },
    { enabled: isOpen },
  );
  const userTimezone = instanceData?.timezone ?? DEFAULT_TIMEZONE;

  // Filter chats by name for quick access
  const filteredChats =
    chatList?.filter((chat) =>
      chat.name.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];

  // Combine results: chat name matches + content matches
  const combinedResults: Array<{
    type: "chat" | "message";
    chatId: string;
    chatName: string;
    preview?: string;
    timestamp?: string;
  }> = [];

  // Add chat name matches
  filteredChats.slice(0, 5).forEach((chat) => {
    combinedResults.push({
      type: "chat",
      chatId: chat.id,
      chatName: chat.name,
    });
  });

  // Add content matches (avoid duplicates)
  const existingChatIds = new Set(combinedResults.map((r) => r.chatId));
  searchResults?.forEach((result) => {
    if (result.chatId && !existingChatIds.has(result.chatId)) {
      const chat = chatList?.find((c) => c.id === result.chatId);
      combinedResults.push({
        type: "message",
        chatId: result.chatId,
        chatName: chat?.name ?? "Unknown Chat",
        preview: result.preview,
        timestamp: result.createdAt,
      });
    }
  });

  const handleSelect = useCallback(
    (chatId: string) => {
      onSelectChat(chatId);
      onClose();
      setQuery("");
      setSelectedIndex(0);
    },
    [onSelectChat, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev < combinedResults.length - 1 ? prev + 1 : 0,
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev > 0 ? prev - 1 : combinedResults.length - 1,
        );
      } else if (e.key === "Enter" && combinedResults[selectedIndex]) {
        e.preventDefault();
        handleSelect(combinedResults[selectedIndex].chatId);
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [combinedResults, selectedIndex, handleSelect, onClose],
  );

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [combinedResults.length]);

  if (!isOpen) return null;

  return (
    <div className="bg-background/40 fixed inset-0 z-50 flex items-start justify-center px-4 pt-[15vh] backdrop-blur-sm">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="bg-card border-border/50 animate-in fade-in zoom-in-95 relative w-full max-w-xl overflow-hidden rounded-xl border shadow-2xl duration-200">
        {/* Search Input */}
        <div className="border-border/50 flex items-center border-b px-4">
          <Search
            className="text-muted-foreground/70 mr-3 h-[18px] w-[18px] shrink-0"
            strokeWidth={1.5}
          />
          <input
            ref={inputRef}
            autoFocus
            className="text-foreground placeholder:text-muted-foreground/50 flex-1 bg-transparent py-4 text-[14px] outline-none"
            placeholder="Search chats and messages..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {isLoading && (
            <Loader2 className="text-muted-foreground mr-2 h-4 w-4 animate-spin" />
          )}
          <button
            onClick={onClose}
            className="text-muted-foreground/70 hover:text-foreground ml-2 rounded-md p-1 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </button>
        </div>

        {/* Results */}
        <div ref={resultsRef} className="max-h-[400px] overflow-y-auto p-2">
          {query.length < 2 ? (
            <div className="flex flex-col items-center justify-center py-8">
              <Search
                className="text-muted-foreground/30 mb-2 h-6 w-6"
                strokeWidth={1.5}
              />
              <p className="text-muted-foreground text-[13px] font-medium">
                Type to search chats and messages...
              </p>
            </div>
          ) : combinedResults.length === 0 && !isLoading ? (
            <div className="flex flex-col items-center justify-center py-8">
              <MessageSquare
                className="text-muted-foreground/30 mb-2 h-6 w-6"
                strokeWidth={1.5}
              />
              <p className="text-muted-foreground text-[13px] font-medium">
                No results found
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {combinedResults.map((result, index) => (
                <button
                  key={`${result.chatId}-${result.type}-${index}`}
                  onClick={() => handleSelect(result.chatId)}
                  className={cn(
                    "flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                    index === selectedIndex
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50 text-foreground",
                  )}
                >
                  <MessageSquare
                    className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
                    strokeWidth={1.5}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium">
                      {result.chatName}
                    </p>
                    {result.preview && (
                      <p className="text-muted-foreground mt-0.5 truncate text-[11px]">
                        {result.preview}
                      </p>
                    )}
                    {result.type === "message" && result.timestamp && (
                      <p className="text-muted-foreground/60 mt-1 text-[10px]">
                        {formatDateTimeLocal(result.timestamp, userTimezone)}
                      </p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="border-border/50 text-muted-foreground/60 flex items-center gap-4 border-t px-4 py-2 text-[11px]">
          <span className="flex items-center gap-1">
            <kbd className="rounded bg-black/5 px-1 py-0.5 text-[10px] dark:bg-white/10">
              ↑↓
            </kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded bg-black/5 px-1 py-0.5 text-[10px] dark:bg-white/10">
              ↵
            </kbd>
            select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded bg-black/5 px-1 py-0.5 text-[10px] dark:bg-white/10">
              esc
            </kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
