"use client";

import { useCallback, useRef, useState } from "react";

export interface TrayAttachment {
  tempId: string;
  id?: string;
  chatId?: string;
  status: "pending" | "processing" | "ready" | "error";
  /** data: URL preview — no blob: CSP dependency. */
  previewUrl: string;
  thumbUrl?: string;
  width?: number;
  height?: number;
  error?: string;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
    r.onerror = () => reject(new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

async function uploadFile(file: File, chatId: string | null, origin: string, signal: AbortSignal) {
  const form = new FormData();
  form.append("file", file);
  if (chatId) form.append("chatId", chatId);
  form.append("origin", origin);
  const res = await fetch("/api/attachments", { method: "POST", body: form, signal });
  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    chatId?: string;
    thumbUrl?: string;
    width?: number;
    height?: number;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? `Upload failed (${res.status})`);
  return body;
}

/**
 * Composer attachment state. Tiles appear on the same frame as paste (local
 * data: preview + shimmer) before any network call completes. Uploads start
 * immediately, even for unsaved New Chats — the server lazily creates the
 * thread and returns its chatId.
 */
export function useAttachments() {
  const [items, setItems] = useState<TrayAttachment[]>([]);
  const controllers = useRef(new Map<string, AbortController>());

  const addFiles = useCallback(
    async (files: File[], chatId: string | null, origin: string, onChatCreated?: (chatId: string) => void) => {
      const candidates = files.filter((f) => f.type.startsWith("image/") || f.size > 0).slice(0, 20 - items.length);
      if (candidates.length === 0) return;
      const seeds: TrayAttachment[] = await Promise.all(
        candidates.map(async (file) => ({
          tempId: crypto.randomUUID(),
          status: "pending" as const,
          previewUrl: await readAsDataUrl(file).catch(() => ""),
        })),
      );
      // Stash File objects on the controller map side-channel.
      const fileByTemp = new Map(seeds.map((s, i) => [s.tempId, candidates[i]!] as const));
      setItems((prev) => [...prev, ...seeds]);

      for (const seed of seeds) {
        const file = fileByTemp.get(seed.tempId);
        if (!file) continue;
        const ctrl = new AbortController();
        controllers.current.set(seed.tempId, ctrl);
        setItems((prev) => prev.map((it) => (it.tempId === seed.tempId ? { ...it, status: "processing" } : it)));
        try {
          const done = await uploadFile(file, chatId, origin, ctrl.signal);
          if (done.chatId && onChatCreated) onChatCreated(done.chatId);
          setItems((prev) =>
            prev.map((it) =>
              it.tempId === seed.tempId
                ? {
                    ...it,
                    status: "ready",
                    id: done.id,
                    chatId: done.chatId,
                    thumbUrl: done.thumbUrl,
                    width: done.width,
                    height: done.height,
                  }
                : it,
            ),
          );
        } catch (err) {
          if (ctrl.signal.aborted) {
            setItems((prev) => prev.filter((it) => it.tempId !== seed.tempId));
          } else {
            setItems((prev) =>
              prev.map((it) =>
                it.tempId === seed.tempId
                  ? { ...it, status: "error", error: err instanceof Error ? err.message : "Upload failed" }
                  : it,
              ),
            );
          }
        } finally {
          controllers.current.delete(seed.tempId);
        }
      }
    },
    [items.length],
  );

  const remove = useCallback((tempId: string) => {
    controllers.current.get(tempId)?.abort();
    controllers.current.delete(tempId);
    setItems((prev) => {
      const target = prev.find((it) => it.tempId === tempId);
      if (target?.id) {
        void fetch(`/api/attachments/${target.id}`, { method: "DELETE" }).catch(() => undefined);
      }
      return prev.filter((it) => it.tempId !== tempId);
    });
  }, []);

  const retry = useCallback(
    (tempId: string, _chatId: string | null) => {
      // Retry needs the original File — re-pick via the tile's Retry is
      // wired to re-upload from preview is impossible, so mark for re-pick.
      // For now surface remove+re-add; full retry-from-bytes waits for
      // File retention (kept out to bound memory on large screenshots).
      setItems((prev) => prev.map((it) => (it.tempId === tempId ? { ...it, status: "error" as const } : it)));
    },
    [],
  );

  const clear = useCallback(() => {
    for (const c of controllers.current.values()) c.abort();
    controllers.current.clear();
    setItems([]);
  }, []);

  return { items, addFiles, remove, retry, clear, setItems };
}

export type AttachmentsApi = ReturnType<typeof useAttachments>;
