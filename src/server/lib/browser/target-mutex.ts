/**
 * Per-target mutual exclusion for browser tool calls (dedication era).
 *
 * One row owns each target, but one project still drives it from many chats
 * at once — and two MCP sessions cannot share a managed profile (probe P2).
 * This serializes calls per target with a bounded wait instead of refusing:
 * the only contender is this project's own other call, itself bounded by
 * tool timeouts, and every holder releases in `finally`.
 *
 * Single-process by design: cron never assembles browser tools
 * (cronSafe:false enforced in toggleMcpTool) and telegram runs in the Next
 * process — the mutex dies with the process, so no stale lease can ever
 * wedge it. Constraint: one serving process per database.
 */
const BUSY_WAIT_MS = 75_000;

type Waiter = { grant: () => void };

const held = new Set<string>();
const queues = new Map<string, Waiter[]>();

function release(target: string): void {
  const q = queues.get(target);
  const next = q?.shift();
  if (q?.length === 0) queues.delete(target);
  if (next) {
    // Ownership transfers to the next waiter; the set stays marked.
    next.grant();
  } else {
    held.delete(target);
  }
}

/** Acquire the target within timeoutMs; false = busy (caller should refuse once, not queue forever). */
export function acquireBrowserTarget(target: string, timeoutMs: number = BUSY_WAIT_MS): Promise<boolean> {
  if (!held.has(target)) {
    held.add(target);
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const q = queues.get(target) ?? [];
    const waiter: Waiter = {
      grant: () => {
        clearTimeout(timer);
        resolve(true);
      },
    };
    const timer = setTimeout(() => {
      const live = queues.get(target);
      if (live) {
        const i = live.indexOf(waiter);
        if (i >= 0) live.splice(i, 1);
        if (live.length === 0) queues.delete(target);
      }
      resolve(false);
    }, timeoutMs);
    q.push(waiter);
    queues.set(target, q);
  });
}

/** Release a held target. Safe to call for a non-held target (no-op). */
export function releaseBrowserTarget(target: string): void {
  if (!held.has(target)) return;
  release(target);
}

export class BrowserBusyError extends Error {
  readonly target: string;
  constructor(target: string) {
    super(
      `Browser is busy with another call on ${target}. Wait for that call to finish, then retry once — do not retry in a loop.`,
    );
    this.name = "BrowserBusyError";
    this.target = target;
  }
}

/** Run fn holding the target (null target runs directly). Throws BrowserBusyError on timeout. */
export async function withBrowserTarget<T>(
  target: string | null,
  fn: () => Promise<T>,
  timeoutMs: number = BUSY_WAIT_MS,
): Promise<T> {
  if (!target) return fn();
  if (!(await acquireBrowserTarget(target, timeoutMs))) throw new BrowserBusyError(target);
  try {
    return await fn();
  } finally {
    releaseBrowserTarget(target);
  }
}
