import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import type { ToolSet } from "ai";
import { env } from "~/env";

/**
 * In-process cache of Composio tool-router sessions, keyed by instanceId.
 *
 * Session creation + tool fetching is the biggest per-turn blocking cost in
 * the agent's hot path. Reusing one session per instance across turns lets a
 * follow-up (that never touches a tool) skip `composio.create()` +
 * `session.tools()` entirely, dramatically cutting time-to-first-token.
 *
 * Sessions are SDK objects with closures bound to `this.sessionId`, so they do
 * NOT serialize to Redis — an in-process Map is the right store. The cache
 * resets on redeploy, which is acceptable (session is rebuilt lazily).
 *
 * IMPORTANT (dependency safety):
 * - Only the AGENT hot path (setup.ts) should use getOrCreateSession().
 * - Connection-status / connect / disconnect tRPC callers must keep creating
 *   FRESH sessions (they need live connection state) and call
 *   invalidateSession(instanceId) after a connect/disconnect so the agent's
 *   next turn rebuilds with updated connection state.
 */

/**
 * Cached agent-session bundle: the tool-router session plus the raw tools
 * fetched from it. Keeping tools cached avoids re-fetching ALL tool schemas
 * (session.tools()) on every turn — the "tool initialization" cost.
 *
 * `session` is a ToolRouterSession (generic SDK class) and `rawTools` is the
 * ToolSet returned by session.tools() — both are opaque here; we only store
 * and return them. tools are session-bound closures, so they're only valid
 * while the session is reused, which the cache guarantees.
 */
interface CachedAgentComposio {
  session: unknown;
  rawTools: ToolSet;
}

const sessionCache = new Map<string, Promise<CachedAgentComposio>>();

export function createComposioClient() {
  return new Composio({
    apiKey: env.COMPOSIO_API_KEY,
    provider: new VercelProvider(),
  });
}

/**
 * Creates a Composio client for a specific project instance.
 * Uses the instance's decrypted per-project API key.
 * Each project must have its own API key for connection isolation.
 */
export function createComposioClientForInstance(decryptedApiKey?: string | null) {
  if (!decryptedApiKey) {
    throw new Error(
      "No Composio API key configured for this project. " +
      "Each project requires its own API key for isolated connections. " +
      "Set a per-project API key in Settings."
    );
  }
  return new Composio({
    apiKey: decryptedApiKey,
    provider: new VercelProvider(),
  });
}

/**
 * Returns a cached { session, rawTools } bundle for `instanceId` (agent hot path
 * only). On hit, skips BOTH `composio.create()` and `session.tools()` network
 * calls — the dominant pre-first-token cost. On connect/disconnect, callers
 * must call invalidateSession() so the bundle rebuilds with new connection state.
 */
export async function getOrCreateSessionAndTools(
  instanceId: string,
  decryptedApiKey?: string | null,
  config?: { manageConnections?: { waitForConnections?: boolean } },
): Promise<CachedAgentComposio> {
  const cached = sessionCache.get(instanceId);
  if (cached) {
    return cached;
  }

  const bundlePromise = (async (): Promise<CachedAgentComposio> => {
    const composio = createComposioClientForInstance(decryptedApiKey);
    const session = await composio.create(instanceId, {
      ...(config ? { manageConnections: config.manageConnections } : {}),
    });
    const rawTools = (await session.tools()) as ToolSet;
    return { session, rawTools };
  })();

  // Deduplicate concurrent creation for the same instance.
  const existing = sessionCache.get(instanceId);
  if (existing) return existing;

  sessionCache.set(instanceId, bundlePromise);

  // Evict on failure so a transient error doesn't poison the cache forever.
  bundlePromise.catch(() => {
    if (sessionCache.get(instanceId) === bundlePromise) {
      sessionCache.delete(instanceId);
    }
  });

  return bundlePromise;
}

/**
 * Evicts a cached session + tools bundle for `instanceId` so the next agent
 * turn rebuilds it. Call after connect/disconnect/onboarding to pick up fresh
 * connection state.
 */
export function invalidateSession(instanceId: string): void {
  sessionCache.delete(instanceId);
}

