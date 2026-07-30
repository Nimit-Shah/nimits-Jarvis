"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Search, MessageSquare, X, Loader2 } from "lucide-react";
import { trpc } from "~/clients/trpc";
import { cn } from "~/lib/utils";

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

  // Filter chats by name for quick access
  const filteredChats = chatList?.filter((chat) =>
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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-background/40 backdrop-blur-sm px-4">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-card border border-border/50 rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Search Input */}
        <div className="flex items-center px-4 border-b border-border/50">
          <Search className="w-[18px] h-[18px] text-muted-foreground/70 mr-3 shrink-0" strokeWidth={1.5} />
          <input
            ref={inputRef}
            autoFocus
            className="flex-1 bg-transparent py-4 outline-none text-[14px] text-foreground placeholder:text-muted-foreground/50"
            placeholder="Search chats and messages..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {isLoading && (
            <Loader2 className="w-4 h-4 text-muted-foreground animate-spin mr-2" />
          )}
          <button
            onClick={onClose}
            className="ml-2 p-1 rounded-md text-muted-foreground/70 hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground transition-colors"
          >
            <X className="w-[18px] h-[18px]" strokeWidth={1.5} />
          </button>
        </div>

        {/* Results */}
        <div ref={resultsRef} className="max-h-[400px] overflow-y-auto p-2">
          {query.length < 2 ? (
            <div className="py-8 flex flex-col items-center justify-center">
              <Search className="w-6 h-6 text-muted-foreground/30 mb-2" strokeWidth={1.5} />
              <p className="text-[13px] text-muted-foreground font-medium">
                Type to search chats and messages...
              </p>
            </div>
          ) : combinedResults.length === 0 && !isLoading ? (
            <div className="py-8 flex flex-col items-center justify-center">
              <MessageSquare className="w-6 h-6 text-muted-foreground/30 mb-2" strokeWidth={1.5} />
              <p className="text-[13px] text-muted-foreground font-medium">
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
                    "flex items-start gap-3 px-3 py-2.5 rounded-lg text-left transition-colors",
                    index === selectedIndex
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50 text-foreground",
                  )}
                >
                  <MessageSquare className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium truncate">
                      {result.chatName}
                    </p>
                    {result.preview && (
                      <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                        {result.preview}
                      </p>
                    )}
                    {result.type === "message" && result.timestamp && (
                      <p className="text-[10px] text-muted-foreground/60 mt-1">
                        {new Date(result.timestamp).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-border/50 flex items-center gap-4 text-[11px] text-muted-foreground/60">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-black/5 dark:bg-white/10 rounded text-[10px]">↑↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-black/5 dark:bg-white/10 rounded text-[10px]">↵</kbd>
            select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-black/5 dark:bg-white/10 rounded text-[10px]">esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
