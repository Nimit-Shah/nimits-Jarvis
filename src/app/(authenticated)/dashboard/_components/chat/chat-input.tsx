"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ArrowUp, Square, Mic, X, FileText } from "lucide-react";
import type { ChatStatus } from "ai";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { ModelSelector } from "./model-selector";
import { FsAccessMenu } from "./fs-access-menu";
import { ComposerAddMenu } from "./composer-add-menu";
import { AttachmentTray } from "./attachment-tray";
import type { AttachmentsApi } from "./use-attachments";
import { trpc } from "~/clients/trpc";
import { useInstanceId } from "~/hooks/use-instance-id";

interface ChatInputProps {
  onSend: (message: string, fsAccessMode?: "read-only" | "full", pinnedSkills?: string[], attachmentIds?: string[]) => void;
  onStop: () => void;
  status: ChatStatus;
  chatId: string;
  attachments: AttachmentsApi;
  onChatCreated?: (chatId: string) => void;
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
  /** Skill pins for this message — per-message, cleared on send (Phase IV) */
  skillsPin?: {
    pinned: string[];
    onToggle: (slug: string) => void;
    onClear: () => void;
  };
}

const MAX_MESSAGE_LENGTH = 50_000;

export function ChatInput({ onSend, onStop, status, chatId, voice, fsAccess, skillsPin, attachments, onChatCreated }: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy = attachments.items.some((it) => it.status === "pending" || it.status === "processing");
  const readyIds = attachments.items.filter((it) => it.status === "ready" && it.id).map((it) => it.id!);
  const hasError = attachments.items.some((it) => it.status === "error");

  // Capability gating: the chat model decides whether attachments are
  // offered at all. `false` disables affordances with an inline note;
  // `unknown` (or loading) allows — the server re-checks authoritatively.
  const [instanceId] = useInstanceId();
  const { data: instance } = trpc.nimitsJarvis.getInstance.useQuery({ instanceId });
  const { data: chats } = trpc.chats.list.useQuery({ instanceId });
  const chatModel = chats?.find((c) => c.id === chatId)?.model
    ?? instance?.instance?.anthropicModel ?? "qwen3:8b";
  const { data: vision } = trpc.nimitsJarvis.getVisionCapability.useQuery(
    { modelId: chatModel },
    { staleTime: 60 * 60 * 1000 },
  );
  const noVision = vision?.capability === false;

  const isStreaming = status === "streaming" || status === "submitted";
  const isTooLong = input.length > MAX_MESSAGE_LENGTH;
  // Model switched mid-tray: attachments persist (switching back re-enables
  // with no re-upload) but Send stays blocked while a non-vision model is set.
  const blockedByVision = noVision && attachments.items.length > 0;
  const canSend = (input.trim().length > 0 || readyIds.length > 0) && !isStreaming && !isTooLong && !busy && !blockedByVision;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [input]);

  const handleSubmit = useCallback(() => {
    if (!canSend) return;
    onSend(input.trim(), fsAccess?.mode, skillsPin?.pinned, readyIds.length > 0 ? readyIds : undefined);
    setInput("");
    skillsPin?.onClear();
    attachments.clear();
  }, [canSend, input, onSend, fsAccess?.mode, skillsPin, readyIds, attachments]);

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
    const files: File[] = [];
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    // Only intercept when at least one image was found — text paste untouched.
    // A model without vision gets the inline note instead of a tile.
    if (files.length > 0) {
      e.preventDefault();
      if (!noVision) void attachments.addFiles(files, chatId || null, "paste", onChatCreated);
    }
  }, [attachments, chatId, onChatCreated, noVision]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if ([...e.dataTransfer.types].includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (files.length > 0) {
      e.preventDefault();
      if (!noVision) void attachments.addFiles(files, chatId || null, "picker", onChatCreated);
    }
  }, [attachments, chatId, onChatCreated, noVision]);

  const micDisabledReason = !voice?.whisperAvailable
    ? "Start the local Whisper server to use voice"
    : isStreaming
      ? "Wait for the response to finish"
      : null;

  return (
    <div className="border-border/50 bg-background border-t p-3 md:p-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {/* Pinned-skill chips — visible pin state above the input (§6.2) */}
        {skillsPin && skillsPin.pinned.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1">
            {skillsPin.pinned.map((slug) => (
              <button
                key={slug}
                onClick={() => skillsPin.onToggle(slug)}
                title="Unpin for this message"
                className="flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 py-0.5 pl-2 pr-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <FileText className="size-3" />
                {slug}
                <X className="size-3" />
              </button>
            ))}
          </div>
        )}
        <div className="relative flex flex-col rounded-2xl border border-border/60 bg-muted/20 p-2.5 shadow-sm focus-within:ring-1 focus-within:ring-ring/40">
          <AttachmentTray items={attachments.items} onRemove={attachments.remove} dimmed={noVision} />
          {noVision && (
            <p className="px-1 pb-1 text-[11px] text-muted-foreground">
              The selected model can&apos;t read images. Switch models to attach one.
            </p>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,image/tiff"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (files.length > 0 && !noVision) void attachments.addFiles(files, chatId || null, "picker", onChatCreated);
            }}
          />
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
              {/* "+" add menu (files + skills) */}
              {skillsPin && (
                <ComposerAddMenu pinned={skillsPin.pinned} onToggle={skillsPin.onToggle} onPickFiles={() => fileInputRef.current?.click()} />
              )}
              {/* FS access dropdown — left slot, beside the add button */}
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
                  title={blockedByVision ? "The selected model can't read images" : busy ? "Waiting for image uploads to finish" : hasError ? "A failed image will be excluded" : undefined}
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

