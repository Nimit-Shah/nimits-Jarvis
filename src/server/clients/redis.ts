import Redis from "ioredis";
import { env } from "~/env";
import { encrypt } from "~/lib/crypto";
import type { PIIVault } from "~/server/api/routers/nimits-jarvis/agent/pii";

// ─── Redis Client ────────────────────────────────────────────────────────────

const globalForRedis = globalThis as typeof globalThis & {
  redis: Redis | undefined;
  redisSubscriber: Redis | undefined;
  redisPublisher: Redis | undefined;
};

export function isRedisConfigured(): boolean {
  return !!env.REDIS_URL;
}

function createRedis(): Redis {
  if (!env.REDIS_URL) {
    throw new Error("Redis not configured");
  }
  const r = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  // ioredis crashes the process on unhandled error events. Surface them in
  // logs instead so connection issues are still visible.
  r.on("error", (err) => {
    console.error("[redis] connection error:", err);
  });
  return r;
}

export function getRedis(): Redis | null {
  if (!env.REDIS_URL) return null;
  globalForRedis.redis ??= createRedis();
  return globalForRedis.redis;
}

/** Dedicated subscriber connection for pub/sub (enters subscriber mode). */
export function getRedisSubscriber(): Redis | null {
  if (!env.REDIS_URL) return null;
  globalForRedis.redisSubscriber ??= createRedis();
  return globalForRedis.redisSubscriber;
}

/** Dedicated publisher connection for pub/sub. */
export function getRedisPublisher(): Redis | null {
  if (!env.REDIS_URL) return null;
  globalForRedis.redisPublisher ??= createRedis();
  return globalForRedis.redisPublisher;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STREAMING_KEY_TTL = 600; // 10 minutes

// ─── Streaming Message Tracker ──────────────────────────────────────────────

export async function setStreamingMessage(
  chatId: string,
  streamId: string,
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(`streaming:${chatId}`, streamId, "EX", STREAMING_KEY_TTL);
}

export async function getStreamingMessage(
  chatId: string,
): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;
  return r.get(`streaming:${chatId}`);
}

export async function clearStreamingMessage(chatId: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.del(`streaming:${chatId}`);
}

/**
 * Atomically claim the in-flight run slot for a chat (`SET NX`).
 * Returns true when this caller owns the slot. Fail-open when Redis is
 * unconfigured so local dev without Redis keeps working (no guard there).
 */
export async function claimChatRun(
  chatId: string,
  streamId: string,
): Promise<boolean> {
  const r = getRedis();
  if (!r) return true;
  const ok = await r.set(
    `streaming:${chatId}`,
    streamId,
    "EX",
    STREAMING_KEY_TTL,
    "NX",
  );
  return ok === "OK";
}

/**
 * Release the in-flight slot only if we still own it (value match), so a
 * failing run can never delete a successor's claim.
 */
export async function releaseChatRun(
  chatId: string,
  streamId: string,
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  const current = await r.get(`streaming:${chatId}`);
  if (current === streamId) {
    await r.del(`streaming:${chatId}`);
  }
  // Per-stream bookkeeping always belongs to this streamId.
  await r.del(`run-asst:${streamId}`);
}

/**
 * Maps a streamId to its pre-created assistant row so out-of-band paths
 * (explicit cancel) can mark terminal state on exactly the right row.
 */
export async function setRunAssistant(
  streamId: string,
  messageId: string,
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(`run-asst:${streamId}`, messageId, "EX", 600);
}

/** Reads and consumes the stream→assistant mapping (single reader). */
export async function takeRunAssistant(
  streamId: string,
): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;
  const value = await r.get(`run-asst:${streamId}`);
  if (value) {
    await r.del(`run-asst:${streamId}`);
  }
  return value;
}

/**
 * Heartbeat refresh for a live run: shorten/extend the pointer TTL only
 * when we still own it. A missing key therefore reads as terminal —
 * including process death, where no heartbeat can run.
 */
export async function expireChatRun(
  chatId: string,
  streamId: string,
  ttlSeconds = 30,
): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  const key = `streaming:${chatId}`;
  const current = await r.get(key);
  if (current !== streamId) return false;
  await r.expire(key, ttlSeconds);
  return true;
}

// ─── Encrypted PII vault snapshots (stream resume) ─────────────────────────
// The resumable stream in Redis is stored TOKENIZED (no restore before
// persisting). Resuming clients need the run's token mappings to restore on
// read, so the vault snapshot is stored here — encrypted, same TTL as the
// run pointer, deleted on every terminal path. Best-effort: if encryption
// or Redis is unavailable, resume serves tokens as-is.

const VAULT_SNAPSHOT_TTL = 600; // 10 minutes

export async function persistVaultSnapshot(
  streamId: string,
  vault: PIIVault,
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    const encrypted = await encrypt(JSON.stringify(vault.snapshot()));
    await r.set(`vault:${streamId}`, encrypted, "EX", VAULT_SNAPSHOT_TTL);
  } catch (err) {
    console.error("[pii] vault snapshot persistence failed:", err);
  }
}

export async function getVaultSnapshot(
  streamId: string,
): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;
  return r.get(`vault:${streamId}`);
}

export async function clearVaultSnapshot(streamId: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.del(`vault:${streamId}`);
}

const IDEMPOTENCY_KEY_TTL = 60; // 1 minute

export interface IdempotencyClaim {
  streamId: string;
  chatId: string | null;
}

function parseIdempotencyValue(raw: string | null): IdempotencyClaim | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      streamId?: unknown;
      chatId?: unknown;
    };
    if (typeof parsed.streamId !== "string") return null;
    return {
      streamId: parsed.streamId,
      chatId: typeof parsed.chatId === "string" ? parsed.chatId : null,
    };
  } catch {
    // Legacy plain-streamId values predate the chatId field.
    return { streamId: raw, chatId: null };
  }
}

/** Read-only probe: who owns this idempotency key, if anyone. */
export async function peekIdempotencyKey(
  key: string,
): Promise<IdempotencyClaim | null> {
  const r = getRedis();
  if (!r) return null;
  return parseIdempotencyValue(await r.get(`chat-idem:${key}`));
}

/**
 * Deduplicate retried/double-fired submits sharing one idempotency key.
 * First caller wins and stores its stream+chat ids; a duplicate gets back
 * the winner so it can attach instead of starting a second run.
 * Returns the winning claim on duplicate, null when this caller claimed it.
 * Fail-open (null) when Redis is unconfigured.
 */
export async function claimIdempotencyKey(
  key: string,
  streamId: string,
  chatId: string,
): Promise<IdempotencyClaim | null> {
  const r = getRedis();
  if (!r) return null;
  const redisKey = `chat-idem:${key}`;
  const value = JSON.stringify({ streamId, chatId });
  const ok = await r.set(redisKey, value, "EX", IDEMPOTENCY_KEY_TTL, "NX");
  if (ok === "OK") return null;
  return parseIdempotencyValue(await r.get(redisKey));
}

// ─── Telegram Deduplication ─────────────────────────────────────────────────

const TELEGRAM_DEDUP_TTL = 300; // 5 minutes

/**
 * Attempt to claim a Telegram update for processing.
 * Returns true if this is the first time we've seen this update_id
 * (i.e. we should process it). Returns false if it's a duplicate/retry.
 */
export async function claimTelegramUpdate(updateId: number): Promise<boolean> {
  const r = getRedis();
  if (!r) return true; // no dedup available - always claim
  const result = await r.set(
    `telegram-update:${updateId}`,
    "1",
    "EX",
    TELEGRAM_DEDUP_TTL,
    "NX",
  );
  return result === "OK";
}

// ─── Telegram Active Generation Tracking ──────────────────────────────────

const TELEGRAM_ACTIVE_TTL = 600; // 10 minutes

/**
 * Mark a Telegram update as the active generation for an instance.
 * A newer update arriving will overwrite this, signaling the old one to abort.
 */
export async function setTelegramActive(
  instanceId: string,
  updateId: number,
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(
    `telegram-active:${instanceId}`,
    String(updateId),
    "EX",
    TELEGRAM_ACTIVE_TTL,
  );
}

/**
 * Get the currently active Telegram update ID for an instance.
 * Returns null if no active generation.
 */
export async function getTelegramActive(
  instanceId: string,
): Promise<number | null> {
  const r = getRedis();
  if (!r) return null;
  const val = await r.get(`telegram-active:${instanceId}`);
  return val ? Number(val) : null;
}
