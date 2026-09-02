"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ArrowUp, Square, Mic } from "lucide-react";
import type { ChatStatus } from "ai";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { showErrorToast } from "~/components/core/toast-notifications";
import { ModelSelector } from "./model-selector";
import { FsAccessMenu } from "./fs-access-menu";

interface ChatInputProps {
  onSend: (message: string, fsAccessMode?: "read-only" | "full") => void;
  onStop: () => void;
  status: ChatStatus;
  chatId: string;
  /** Voice mode controls injected from the parent */
  voice?: {
    whisperAvailable: boolean;
    onOpenVoiceMode: () => void;
  };
  /** Filesystem access mode + ceiling (Phase A) */
  fsAccess?: {
    mode: "read-only" | "full";
    onModeChange: (mode: "read-only" | "full") => void;
    fsWriteAllowed?: boolean;
    instanceResolved?: boolean;
  };
}

const MAX_MESSAGE_LENGTH = 50_000;

export function ChatInput({ onSend, onStop, status, chatId, voice, fsAccess }: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isStreaming = status === "streaming" || status === "submitted";
  const isTooLong = input.length > MAX_MESSAGE_LENGTH;
  const canSend = input.trim().length > 0 && !isStreaming && !isTooLong;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [input]);

  const handleSubmit = useCallback(() => {
    if (!canSend) return;
    onSend(input.trim(), fsAccess?.mode);
    setInput("");
  }, [canSend, input, onSend, fsAccess?.mode]);

  const handleStop = useCallback(() => {
    onStop();
  }, [onStop]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming) return;
      handleSubmit();
    }
  };

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.type.startsWith("image/") || item.kind === "file") {
        e.preventDefault();
        showErrorToast("This model does not support image input");
        return;
      }
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "none";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    showErrorToast("This model does not support image input");
  }, []);

  const micDisabledReason = !voice?.whisperAvailable
    ? "Start the local Whisper server to use voice"
    : isStreaming
      ? "Wait for the response to finish"
      : null;

  return (
    <div className="border-border/50 bg-background border-t p-3 md:p-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <div className="relative flex flex-col rounded-2xl border border-border/60 bg-muted/20 p-2.5 shadow-sm focus-within:ring-1 focus-within:ring-ring/40">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            placeholder={
              isStreaming ? "Waiting for response..." : "Ask me anything..."
            }
            disabled={isStreaming}
            rows={1}
            className={cn(
              "max-h-[200px] min-h-[40px] resize-none border-0 bg-transparent text-[13px] shadow-none focus-visible:ring-0",
              "placeholder:text-muted-foreground/40",
            )}
          />

          <div className="flex items-center justify-between pt-2 px-1">
            <div className="flex items-center">
              {/* FS access dropdown — left slot, beside the (future) attachment button */}
              {fsAccess && (
                <FsAccessMenu
                  mode={fsAccess.mode}
                  onModeChange={fsAccess.onModeChange}
                  fsWriteAllowed={fsAccess.fsWriteAllowed}
                  instanceResolved={fsAccess.instanceResolved ?? true}
                />
              )}
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2">
              <ModelSelector chatId={chatId} />

              {/* Mic / Voice Mode button */}
              {voice && (
                <div className="relative" title={micDisabledReason ?? "Open voice mode (Jarvis)"}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "size-8 rounded-full transition-colors",
                      voice.whisperAvailable && !isStreaming
                        ? "text-muted-foreground hover:bg-white/10 hover:text-foreground"
                        : "cursor-not-allowed opacity-40",
                    )}
                    onClick={voice.whisperAvailable && !isStreaming ? voice.onOpenVoiceMode : undefined}
                    disabled={!voice.whisperAvailable || isStreaming}
                    aria-label={micDisabledReason ?? "Open voice mode"}
                    id="voice-mode-btn"
                  >
                    <Mic className="size-4" />
                  </Button>
                  {/* Online indicator dot */}
                  {voice.whisperAvailable && (
                    <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-cyan-400 ring-1 ring-background" />
                  )}
                </div>
              )}

              {isStreaming ? (
                <Button
                  variant="default"
                  size="icon"
                  className="size-8 rounded-xl bg-destructive hover:bg-destructive/90"
                  onClick={handleStop}
                >
                  <Square className="size-3 fill-current text-destructive-foreground" />
                </Button>
              ) : (
                <Button
                  variant="default"
                  size="icon"
                  className={cn(
                    "size-8 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90",
                    !canSend && "opacity-50",
                  )}
                  onClick={handleSubmit}
                  disabled={!canSend}
                >
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
        
        {isTooLong && (
          <div className="px-2">
            <p className="text-destructive text-xs">
              Message is too long ({input.length.toLocaleString()}/
              {MAX_MESSAGE_LENGTH.toLocaleString()})
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

