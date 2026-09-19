"use client";

import { useState, useRef, useEffect } from "react";
import { Copy, Check, Download } from "lucide-react";
import type { UIMessage } from "@ai-sdk/react";
import { MessageTimestamp } from "./message-timestamp";
import { useChatContext } from "../chat-context";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "~/components/ui/dialog";

interface UserMessageProps {
  message: UIMessage;
}

export function UserMessage({ message }: UserMessageProps) {
  const [copied, setCopied] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const { timezone } = useChatContext();
  const createdAt = (message.metadata as { createdAt?: string } | undefined)
    ?.createdAt;

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const textContent = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");

  const imageParts = message.parts.filter(
    (p): p is { type: "file"; mediaType: string; url: string } =>
      p.type === "file" && typeof (p as { url?: unknown }).url === "string",
  );

  const lightboxSentUrl = lightbox?.replace("variant=thumb", "variant=sent") ?? null;

  const handleCopy = () => {
    void navigator.clipboard.writeText(textContent);
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };

  const paragraphs = textContent.split(/\n\n+/).filter(Boolean);

  return (
    <div className="group flex flex-col items-end">
      <div className="relative max-w-[80%]">
        {imageParts.length > 0 && (
          <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
            {imageParts.map((p) => (
              <button
                key={p.url}
                onClick={() => setLightbox(p.url)}
                className="overflow-hidden rounded-xl border border-border/60"
                aria-label="View image fullscreen"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.url}
                  alt="Attached image"
                  className="h-24 w-auto object-cover transition-opacity hover:opacity-90"
                />
              </button>
            ))}
          </div>
        )}
        <div className="bg-muted text-foreground space-y-1 rounded-2xl px-3 py-2 text-[12px]">
          {paragraphs.map((p, i) => (
            <p key={i} className="leading-relaxed whitespace-pre-wrap">
              {p}
            </p>
          ))}
        </div>
      </div>

      <div className="mt-1 mr-1 flex items-center gap-2">
        {createdAt && (
          <MessageTimestamp
            createdAt={createdAt}
            timezone={timezone}
            className="opacity-0 group-hover:opacity-100"
          />
        )}
        <button
          onClick={handleCopy}
          className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        >
          {copied ? (
            <Check className="size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </button>
      </div>

      <Dialog open={lightbox !== null} onOpenChange={(open) => { if (!open) setLightbox(null); }}>
        <DialogContent className="max-w-4xl border-border/60 bg-background p-2">
          <DialogTitle className="sr-only">Attached image</DialogTitle>
          {lightboxSentUrl && (
            <div className="flex flex-col gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={lightboxSentUrl}
                alt="Attached image fullscreen"
                className="max-h-[80vh] w-auto self-center rounded-lg object-contain"
              />
              <a
                href={lightboxSentUrl}
                download
                className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 self-end text-xs transition-colors"
              >
                <Download className="size-3.5" />
                Download
              </a>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
