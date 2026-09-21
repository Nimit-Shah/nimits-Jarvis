import { createHash } from "crypto";
import { tool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import type { JSONSchema7 } from "json-schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { db } from "~/server/clients/db";
import { decrypt } from "~/lib/crypto";
import { ingestMcpScreenshots, type McpContentBlock } from "~/server/lib/browser/mcp-images";
import {
  assertSafeMcpUrl,
  classifyReachability,
  isReachableHere,
} from "~/lib/mcp-url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CachedMcpClient = {
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
  connectedAt: number;
  lastUsedAt: number;
};

type McpServerRow = {
  id: string;
  name: string;
  label: string;
  url: string;
  headersEnc: string | null;
  browserMode?: string | null;
  cdpConfirmed?: boolean | null;
};

type McpToolWithServer = {
  id: string;
  mcpServerId: string;
  originalName: string;
  namespacedName: string;
  description: string | null;
  inputSchema: unknown;
  server: McpServerRow;
};

// ---------------------------------------------------------------------------
// Cache — globalThis survives Next.js HMR, shared across streams
// ---------------------------------------------------------------------------

const IDLE_TTL_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;

// Per-tool call budgets (keyed by upstream tool name). Heavy SPA navigation
// can exceed the shared default; the global stays untouched for every other
// MCP server.
const TOOL_TIMEOUT_OVERRIDES: Readonly<Record<string, number>> = {
  browser_navigate: 60_000,
  browser_wait_for: 60_000,
};

const g = globalThis as unknown as { __jarvisMcpClients?: Map<string, CachedMcpClient> };
const clients: Map<string, CachedMcpClient> = (g.__jarvisMcpClients ??= new Map());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () =>
        reject(new Error(`Timed out after ${ms}ms`)),
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export function toNamespacedName(serverSlug: string, toolName: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const full = `mcp__${clean(serverSlug)}__${clean(toolName)}`;
  if (full.length <= 64) return full;
  const hash = createHash("sha1").update(full).digest("hex").slice(0, 6);
  return `${full.slice(0, 57)}_${hash}`;
}

function prefixDescription(label: string, desc?: string): string {
  return `[${label}] ${desc ?? ""}`.trim();
}

// Description suffixes applied at discovery time (stored in DB, visible in
// Settings). These are guidance, not routers: they steer tool choice without
// deciding it. Keep this map tiny and generic across MCP servers.
const DESCRIPTION_GUIDANCE: Readonly<Record<string, string>> = {
  // Screenshots carry no element refs (browser_click needs snapshot refs) and
  // cost ~1.1–1.6k tokens each — snapshot is the primary loop.
  browser_take_screenshot:
    "Guidance: use browser_snapshot to find and act on elements; screenshots only when the question is about visual appearance.",
  // Blocked pages are indistinguishable from broken sites at the network
  // layer — give the model a diagnostic path instead of retry fuel.
  browser_navigate:
    "Guidance: if a navigation fails or a page renders without styles, the site may be blocked by this server's origin policy rather than unavailable. Call browser_network_requests to check for failed entries, and report the blocked origin instead of retrying.",
};

function sanitizeJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const obj = schema as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...obj };
  delete copy.$schema;
  // Inline or drop $ref/definitions conservatively — drop if present
  if ("$ref" in copy) delete copy.$ref;
  if ("definitions" in copy) delete copy.definitions;
  if ("$defs" in copy) delete copy.$defs;
  return copy;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}

async function markServerFailed(serverId: string, err: unknown): Promise<void> {
  try {
    await db.mcpServer.update({
      where: { id: serverId },
      data: { status: "failed", lastError: describeError(err) },
    });
  } catch {
    // best-effort
  }
}

function normalizeMcpResult(result: unknown): unknown {
  const r = result as {
    content?: Array<{ type: string; text?: string; data?: string; mimeType?: string; uri?: string }>;
    isError?: boolean;
  };
  if (!r || !Array.isArray(r.content)) return result;
  const texts: string[] = [];
  for (const block of r.content) {
    if (block.type === "text" && block.text) texts.push(block.text);
    else if (block.type === "image")
      // Explicit blindness: image bytes never reach the model today (Phase 4
      // routes them into MessageAttachment with origin "mcp"). A bare
      // "[image: ...]" placeholder degrades silently — the model confabulates
      // about a page it cannot see. Say so, and point at the snapshot loop.
      texts.push(
        `[image: ${block.mimeType ?? "unknown"} — not visible to this model; use browser_snapshot for page structure and element refs]`,
      );
    else if (block.type === "resource" && block.uri) texts.push(`[resource: ${block.uri}]`);
    else if (block.text) texts.push(block.text);
  }
  // Return flattened text so agent loop already handles it
  if (r.isError) return { isError: true as const, message: texts.join("\n") || "MCP tool error" };
  return texts.join("\n") || result;
}

const SCREENSHOT_HINT_RE = /\.playwright-mcp\/[^\s)]+\.(?:png|jpe?g|webp)/i;

/**
 * Screenshot last mile: persist MCP image blocks / server-side screenshot
 * files into MessageAttachment (origin "mcp") and return them view_image
 * shaped (dataUrl on the volatile tail). Returns null when the result
 * carries no pixels, letting the text normalizer handle it.
 */
async function resolveMcpImages(
  result: unknown,
  ctx: { instanceId: string; chatId: string },
): Promise<unknown | null> {
  const r = result as { content?: McpContentBlock[] };
  if (!r || !Array.isArray(r.content)) return null;
  const hasImage = r.content.some((b) => b.type === "image" && b.data);
  const hasPathRef =
    !hasImage && r.content.some((b) => b.type === "text" && b.text && SCREENSHOT_HINT_RE.test(b.text));
  if (!hasImage && !hasPathRef) return null;

  const text = normalizeMcpResult(result);
  const textStr = typeof text === "string" ? text : JSON.stringify(text);
  try {
    const images = await ingestMcpScreenshots({ instanceId: ctx.instanceId, chatId: ctx.chatId, blocks: r.content });
    if (images.length === 0) {
      return {
        text: textStr,
        note: "The screenshot was saved on the MCP server but is not readable from here — describe what you need from browser_snapshot instead of retrying.",
      };
    }
    return { text: textStr, screenshots: images };
  } catch (err) {
    console.error("[mcp] screenshot ingest failed", { err, chatId: ctx.chatId });
    return {
      text: textStr,
      note: "The screenshot could not be attached for viewing — describe what you need from browser_snapshot instead of retrying.",
    };
  }
}

// ---------------------------------------------------------------------------
// getOrCreateMcpClient — single server, idle TTL, fail-fast, no retry loop
// ---------------------------------------------------------------------------

async function getOrCreateMcpClient(server: McpServerRow): Promise<Client> {
  const now = Date.now();
  const hit = clients.get(server.id);
  if (hit && now - hit.lastUsedAt < IDLE_TTL_MS) {
    hit.lastUsedAt = now;
    return hit.client;
  }
  if (hit) {
    await hit.client.close().catch(() => {});
    clients.delete(server.id);
  }

  assertSafeMcpUrl(server.url);
  const headers: Record<string, string> | undefined = server.headersEnc
    ? (JSON.parse(await decrypt(server.headersEnc)) as Record<string, string>)
    : undefined;

  const url = new URL(server.url);
  // Streamable HTTP is default for this codebase (one connector). SSE only if URL hints legacy.
  const isSse = server.url.includes("/sse") || server.url.includes("sse=");
  const transport: StreamableHTTPClientTransport | SSEClientTransport = isSse
    ? new SSEClientTransport(url)
    : new StreamableHTTPClientTransport(url, headers ? { requestInit: { headers } } : undefined);

  const client = new Client({ name: "nimits-jarvis", version: "0.1.0" }, { capabilities: {} });

  await withTimeout(client.connect(transport as never), CONNECT_TIMEOUT_MS);

  clients.set(server.id, { client, transport, connectedAt: now, lastUsedAt: now });
  return client;
}

export function invalidateMcpClient(serverId: string): void {
  const hit = clients.get(serverId);
  if (hit) {
    hit.client.close().catch(() => {});
    clients.delete(serverId);
  }
}

export function invalidateMcpClientsForInstance(_instanceId: string): void {
  // Per-server cache is keyed by server.id which is cuid — we need to know which
  // server belongs to which instance. Instead of tracking, clear on instance-level
  // invalidation is best-effort: caller should pass serverIds. Fallback clears all for same instance is handled by DB layer.
  // For now, this is a no-op placeholder — individual server invalidation is used.
}

// ---------------------------------------------------------------------------
// discoverMcpTools — settings-time only, only place listTools() is called
// ---------------------------------------------------------------------------

export async function discoverMcpTools(server: McpServerRow): Promise<
  Array<{
    originalName: string;
    namespacedName: string;
    description: string;
    inputSchema: unknown;
  }>
> {
  const client = await getOrCreateMcpClient(server);
  const result = await client.listTools();
  const tools = (result.tools ?? []) as Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
  }>;

  return tools.map((t) => ({
    originalName: t.name,
    namespacedName: toNamespacedName(server.name, t.name),
    description: prefixDescription(
      server.label,
      t.description && DESCRIPTION_GUIDANCE[t.name]
        ? `${t.description} ${DESCRIPTION_GUIDANCE[t.name]}`
        : (t.description ?? DESCRIPTION_GUIDANCE[t.name]),
    ),
    inputSchema: sanitizeJsonSchema(t.inputSchema),
  }));
}

export async function syncToolsForServer(serverId: string): Promise<void> {
  const server = await db.mcpServer.findUnique({ where: { id: serverId } });
  if (!server) throw new Error("Server not found");

  const discovered = await discoverMcpTools(server as McpServerRow);

  // Upsert — preserve existing enabled/cronSafe
  for (const d of discovered) {
    await db.mcpTool.upsert({
      where: { mcpServerId_originalName: { mcpServerId: serverId, originalName: d.originalName } },
      create: {
        mcpServerId: serverId,
        originalName: d.originalName,
        namespacedName: d.namespacedName,
        description: d.description,
        inputSchema: d.inputSchema as never,
        enabled: false,
        cronSafe: false,
      },
      update: {
        namespacedName: d.namespacedName,
        description: d.description,
        inputSchema: d.inputSchema as never,
      },
    });
  }

  // Delete tools that vanished
  const discoveredNames = new Set(discovered.map((d) => d.originalName));
  const existing = await db.mcpTool.findMany({ where: { mcpServerId: serverId }, select: { originalName: true, id: true } });
  for (const row of existing) {
    if (!discoveredNames.has(row.originalName)) {
      await db.mcpTool.delete({ where: { id: row.id } });
    }
  }

  await db.mcpServer.update({
    where: { id: serverId },
    data: { status: "ok", lastError: null, lastSyncedAt: new Date(), needsSync: false },
  });
}

// ---------------------------------------------------------------------------
// getOrCreateMcpTools — hot path, every prepareAgentRun, never throws
// ---------------------------------------------------------------------------

export async function getOrCreateMcpTools(
  instanceId: string,
  source: "web" | "telegram" | "cron",
  chatId?: string,
): Promise<ToolSet> {
  try {
    const rows = (await db.mcpTool.findMany({
      where: {
        enabled: true,
        ...(source === "cron" ? { cronSafe: true } : {}),
        server: { instanceId, enabled: true },
      },
      include: { server: true },
    })) as unknown as McpToolWithServer[];

    const usable = rows.filter(
      (r) =>
        isReachableHere(classifyReachability(r.server.url)) &&
        // CDP attaches to a live, possibly authenticated browser: explicit
        // per-server opt-in, and never on unattended sources. Gate by
        // availability, not runtime rejection.
        (r.server.browserMode !== "cdp" || (source === "web" && r.server.cdpConfirmed === true)),
    );

    const set: ToolSet = {};
    const imgCtx = chatId ? { instanceId, chatId } : null;
    for (const row of usable) {
      set[row.namespacedName] = tool({
        description: row.description ?? undefined,
        inputSchema: jsonSchema(row.inputSchema as JSONSchema7),
        execute: async (args) => callMcpTool(row, args, imgCtx),
      });
    }
    return set;
  } catch (err) {
    console.error("[mcp] toolset assembly failed", { err, instanceId });
    return {};
  }
}

async function callMcpTool(
  row: McpToolWithServer,
  args: unknown,
  imgCtx: { instanceId: string; chatId: string } | null,
): Promise<unknown> {
  const timeout = TOOL_TIMEOUT_OVERRIDES[row.originalName] ?? CALL_TIMEOUT_MS;
  try {
    const client = await getOrCreateMcpClient(row.server);
    const result = await withTimeout(
      client.callTool({ name: row.originalName, arguments: args as Record<string, unknown> }),
      timeout,
    );
    if (imgCtx) {
      const withImages = await resolveMcpImages(result, imgCtx);
      if (withImages) return withImages;
    }
    return normalizeMcpResult(result);
  } catch (err) {
    const msg = describeError(err);
    // Self-heal: a server restart wipes Streamable HTTP sessions, so the
    // cached client's session id goes stale ("Session not found/expired").
    // Drop the cached client and retry once with a fresh initialize instead
    // of wedging every tool until process restart.
    if (/session (not found|expired|unknown)|unknown session|invalid session/i.test(msg)) {
      invalidateMcpClient(row.server.id);
      try {
        const client = await getOrCreateMcpClient(row.server);
        const result = await withTimeout(
          client.callTool({ name: row.originalName, arguments: args as Record<string, unknown> }),
          timeout,
        );
        if (imgCtx) {
          const withImages = await resolveMcpImages(result, imgCtx);
          if (withImages) return withImages;
        }
        return normalizeMcpResult(result);
      } catch (retryErr) {
        err = retryErr;
      }
    }
    await markServerFailed(row.mcpServerId, err);
    const finalMsg = describeError(err);
    // Set needsSync hint on unknown-tool / invalid-arguments — but not on
    // session errors, which are transient reconnects, not schema drift.
    if (/unknown tool|invalid arguments/i.test(finalMsg)) {
      try {
        await db.mcpServer.update({ where: { id: row.mcpServerId }, data: { needsSync: true } });
      } catch {}
    }
    return { isError: true as const, message: `MCP ${row.server.label}/${row.originalName}: ${finalMsg}` };
  }
}
