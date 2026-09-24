import { expireChatRun } from "~/server/clients/redis";

/**
 * Per-process registry of live web-chat agent runs, keyed by streamId.
 *
 * Two jobs:
 * 1. Explicit cancellation — the Stop button (DELETE /api/chat) aborts the
 *    run's controller instead of merely dropping the HTTP connection.
 * 2. Heartbeat — while a run is alive, the Redis `streaming:{chatId}` pointer
 *    is refreshed every 10s with a short TTL. A missing key therefore means
 *    the run is terminal (process death included), never "maybe live".
 *
 * Single-process only: on serverless the registry vanishes between
 * invocations (see the `canBackground` gate in the chat route).
 */

interface RunEntry {
  controller: AbortController;
  heartbeat: NodeJS.Timeout | null;
}

const g = globalThis as unknown as {
  __jarvisRuns?: Map<string, RunEntry>;
};
const runs = (g.__jarvisRuns ??= new Map<string, RunEntry>());

/** True when background continuation is possible in this runtime. */
export const canBackground = !process.env.VERCEL;

export function registerRun(streamId: string): AbortController {
  releaseRun(streamId);
  const controller = new AbortController();
  runs.set(streamId, { controller, heartbeat: null });
  return controller;
}

export function startRunHeartbeat(chatId: string, streamId: string): void {
  const entry = runs.get(streamId);
  if (!entry || entry.heartbeat) return;
  entry.heartbeat = setInterval(() => {
    void expireChatRun(chatId, streamId, 30).catch((err: unknown) =>
      console.error("[chat/heartbeat] refresh failed:", err),
    );
  }, 10_000);
  // Don't hold the process open for bookkeeping alone.
  entry.heartbeat.unref?.();
}

export function cancelRun(streamId: string): void {
  const entry = runs.get(streamId);
  if (entry) {
    try {
      entry.controller.abort();
    } catch {
      // Ignore — abort is best-effort; release still runs.
    }
  }
  releaseRun(streamId);
}

export function releaseRun(streamId: string): void {
  const entry = runs.get(streamId);
  if (entry?.heartbeat) {
    clearInterval(entry.heartbeat);
  }
  runs.delete(streamId);
}
