import { db } from "~/server/clients/db";
import { getInstanceForUser } from "./utils";

// ── Per-instance write mutex ────────────────────────────────────────────────
// One write at a time per instance. Two approvals clicked in quick succession
// on the same file would otherwise interleave, and the second would see a
// stale digest for reasons that look like a bug.
const instanceMutexes = new Map<string, Promise<unknown>>();

export function withInstanceLock<T>(instanceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = instanceMutexes.get(instanceId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  instanceMutexes.set(
    instanceId,
    next.catch(() => {}),
  );
  return next;
}

/** Confused-deputy guard: the caller must own the instance the change belongs to. */
export async function assertInstanceOwnedByUser(userId: string, instanceId: string): Promise<void> {
  await getInstanceForUser(userId, instanceId);
}

export { db };
