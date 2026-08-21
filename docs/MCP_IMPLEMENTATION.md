# PART II — MCP IMPLEMENTATION INSTRUCTIONS

Markdown source. Copy this part verbatim into docs/MCP_IMPLEMENTATION.md in the repository. It supersedes any earlier MCP notes. Line references are to commit 2def2ec6a15e4b284162c993b7ca18a1ca04a036; re-locate by symbol name if they have drifted.

## 0. Design rules — read before writing any code

These eight rules are the ones most likely to be violated by an implementer who skips ahead. Every later section assumes them.

1. **One merge point.** Every tool the model can see arrives through the single `wrapToolExecutors(...)` call at `setup.ts` L406. Never call it twice. Never hand the model a second toolset alongside it. That call is what applies the entire PII pipeline, and it is source-agnostic, so being inside it is the only thing MCP tools need in order to inherit redaction.

2. **There is no routing layer.** Tool selection is the model's job — function calling *is* routing. `prepareAgentRun()` decides what is *available*; the model decides what is *called*. Never inspect the user's message to choose tools. If you write `if (message.includes(...))` anywhere near toolset assembly, delete it.

3. **Availability filtering is deterministic and message-independent.** The complete list of legitimate filters: per-server `enabled`, per-tool `enabled`, reachability vs. current runtime, `source === "cron"` against `cronSafe`, and known-failed connection state. Nothing else.

4. **One connector, not two.** A loopback server (`http://127.0.0.1:3845/mcp`) and a remote server (`https://mcp.example.com/mcp`) use the same transport, client, and code path. Local vs. remote is derived from the URL, never a mode the user selects and never a branch in the client. The only thing reachability changes is whether a server is filtered out.

5. **Discovery and execution are separate phases.** Discovery connects and calls `listTools()`, and happens only when the user adds or syncs a server. Execution builds tools from cached schemas and connects lazily, only if the model actually invokes one. Never call `listTools()` inside `prepareAgentRun()` — it sits in the hot path of every entry point.

6. **Namespacing is a security control.** All MCP tool names are `mcp__<server>__<tool>`. Without the prefix, an MCP server can declare `GMAIL_SEND_EMAIL` and shadow the real OAuth-brokered Composio tool in the spread, and MCP servers are user-supplied configuration.

7. **Nothing in the assembly path throws.** A dead server, a bad URL, an expired token — all yield an empty ToolSet plus a logged error. A misconfigured MCP server must never break a chat message, a Telegram reply, or a cron run.

8. **Everything is instance-scoped.** Config rows, cache keys, credentials. A global cache leaks sessions between projects and breaks the isolation guarantee that the rest of the system is built on.

## 1. Dependencies and TypeScript configuration

```bash
pnpm add @modelcontextprotocol/sdk
```

`ai` and `@ai-sdk/react` are already installed. Before writing the client, confirm the `ai` version actually exports `experimental_createMCPClient` — it is experimental and has moved between versions. If the export is missing, upgrade `ai` rather than working around it.

`@modelcontextprotocol/sdk` is needed only for `StreamableHTTPClientTransport`. It ships ESM subpath exports, so `tsconfig.json` must have `"moduleResolution": "bundler"` (or `"node16"`) and imports must carry `.js` extensions:

```ts
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
```

Do not install `fastmcp` (server-authoring only, cannot act as a client) and do not attempt `@modelcontextprotocol/client` (no such package exists).

## 2. Prisma schema

Two tables, not one. `McpServer` holds connection config; `McpTool` caches discovered tool schemas so the settings UI can render a checkbox list without opening a connection, and so the run-time path never needs `listTools()`.

```prisma
model McpServer {
  id            String   @id @default(cuid())
  instanceId    String
  instance      ComposioClawInstance @relation(fields: [instanceId], references: [id], onDelete: Cascade)

  name          String   // slug: lowercase, [a-z0-9-]; becomes the namespace segment
  label         String   // human display name, freely editable
  url           String   // http://127.0.0.1:3845/mcp | https://mcp.example.com/mcp
  headersEnc    String?  // AES-256-GCM ciphertext of Record<string,string>
  enabled       Boolean  @default(true)

  status        String   @default("unknown") // unknown | ok | failed | unreachable
  lastError     String?
  lastSyncedAt  DateTime?
  needsSync     Boolean  @default(false)

  tools         McpTool[]
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([instanceId, name])
  @@index([instanceId])
}

model McpTool {
  id              String   @id @default(cuid())
  mcpServerId     String
  server          McpServer @relation(fields: [mcpServerId], references: [id], onDelete: Cascade)

  originalName    String   // exact name to send back in callTool()
  namespacedName  String   // mcp__<server>__<tool>; what the model sees
  description     String?
  inputSchema     Json     // JSON Schema as returned by listTools()

  enabled         Boolean  @default(false) // OFF by default - see section 9
  cronSafe        Boolean  @default(false) // see section 11

  @@unique([mcpServerId, originalName])
  @@index([mcpServerId, enabled])
}
```

Add the back-relation `mcpServers McpServer[]` to the existing `ComposioClawInstance` model. Apply with the repository's existing workflow (`pnpm prisma db push`).

Three schema decisions worth not undoing:

- **Separate table rather than a JSON column on the instance.** Each server needs its own ciphertext (its own initialization vector), its own status fields, and an independent enable toggle. A JSON blob forces re-encrypting everything to change one header.

- **`enabled` defaults to `false` on `McpTool`.** A server exposing forty tools would otherwise silently inflate every request. Discovery should never change what the model sees; only an explicit user action should.

- **`namespacedName` is stored, not computed at read time.** It is the stable identity across syncs and the key the model uses. Computing it on the fly means a slug rename silently orphans nothing and breaks everything.

## 3. URL classification and credential helpers

New file: `src/server/lib/mcp-url.ts`. Reachability is derived from the URL — it is never user input.

```ts
export type Reachability = "loopback" | "private" | "remote";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const BLOCKED  = new Set(["169.254.169.254", "metadata.google.internal"]);

export function assertSafeMcpUrl(raw: string): URL {
  const u = new URL(raw); // throws on malformed input — catch at the procedure boundary
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("MCP server URL must be http or https");
  }
  if (BLOCKED.has(u.hostname)) {
    throw new Error("That address is not permitted");
  }
  return u;
}

export function classifyReachability(raw: string): Reachability {
  const { hostname } = new URL(raw);
  if (LOOPBACK.has(hostname)) return "loopback";
  if (/^10\./.test(hostname)) return "private";
  if (/^192\.168\./.test(hostname)) return "private";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return "private";
  return "remote";
}

// True when this process can plausibly reach the address.
export function isReachableHere(r: Reachability): boolean {
  const serverless = Boolean(process.env.VERCEL);
  return r === "remote" ? true : !serverless;
}
```

The metadata-endpoint block matters more than it looks. Accepting arbitrary user-supplied URLs and fetching them is textbook server-side request forgery; here it is deliberate and necessary, because loopback is the primary use case. Blocking `169.254.169.254` is the three lines that stop "configure your local MCP server" from becoming cloud-credential theft on any hosted deployment.

Credentials reuse the existing helpers — the same `encrypt`/`decrypt` pair already used for the Composio API key (called at `setup.ts` L360). Headers and bearer tokens are credentials: encrypted at rest, never logged, never returned to the client by any tRPC procedure. `listMcpServers` must return a boolean `hasHeaders`, not the header values.

## 4. The client module — src/server/clients/mcp.ts

Mirror `src/server/clients/composio.ts` (`CachedAgentComposio` L36, `createComposioClientForInstance` L55, `getOrCreateSessionAndTools` L75). Same shape, same naming style, same directory. Four exports, in dependency order.

### 4.1 Connection cache

Cached on `globalThis` so it survives Next.js module reloads in development and is shared across concurrent streams in production. Keyed by server id, which is already instance-scoped.

```ts
type CachedMcpClient = {
  client: Awaited<ReturnType<typeof experimental_createMCPClient>>;
  connectedAt: number;
  lastUsedAt: number;
};

const IDLE_TTL_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;

const g = globalThis as unknown as { __jarvisMcpClients?: Map<string, CachedMcpClient> };
const clients: Map<string, CachedMcpClient> = (g.__jarvisMcpClients ??= new Map());
```

### 4.2 getOrCreateMcpClient(server)

```ts
async function getOrCreateMcpClient(server: McpServer) {
  const now = Date.now();
  const hit = clients.get(server.id);
  if (hit && now - hit.lastUsedAt < IDLE_TTL_MS) {
    hit.lastUsedAt = now;
    return hit.client;
  }
  if (hit) { await hit.client.close().catch(() => {}); clients.delete(server.id); }

  assertSafeMcpUrl(server.url);
  const headers = server.headersEnc
    ? (JSON.parse(decrypt(server.headersEnc)) as Record<string, string>)
    : undefined;

  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: headers ? { headers } : undefined,
  });

  const client = await withTimeout(
    experimental_createMCPClient({ transport }),
    CONNECT_TIMEOUT_MS,
  );

  clients.set(server.id, { client, connectedAt: now, lastUsedAt: now });
  return client;
}
```

Notes on this function specifically:

- Idle eviction rather than permanent caching. A loopback server the user restarted leaves a dead session behind; a five-minute TTL means the next call reconnects instead of failing forever.

- `withTimeout` is a local helper wrapping `Promise.race` with an `AbortController`. Without it, a loopback server whose process is stopped but whose port is still bound will hang the request until the platform kills it.

- Do not add retry loops here. One attempt, fail fast, surface the error. Retries belong to the user pressing "Test connection".

### 4.3 discoverMcpTools(server) — settings-time only

This is the only place `listTools()` is called. It runs from the `syncMcpTools` procedure, never from `prepareAgentRun()`.

```ts
export async function discoverMcpTools(server: McpServer) {
  const client = await getOrCreateMcpClient(server);
  const { tools } = await client.listTools(); // raw MCP descriptors

  return tools.map((t) => ({
    originalName: t.name,
    namespacedName: toNamespacedName(server.name, t.name),
    description: prefixDescription(server.label, t.description),
    inputSchema: sanitizeJsonSchema(t.inputSchema),
  }));
}
```

`sanitizeJsonSchema` strips what provider tool-validators reject: delete `$schema`, and inline or drop `$ref`/`definitions`. Most models tolerate the rest. Keep it conservative — dropping an unknown keyword is better than failing the whole tool.

`prefixDescription` is the disambiguation mechanism described in section 10. It prepends the server label and scope so the model can tell two similar tools apart:

```ts
const prefixDescription = (label: string, desc?: string) =>
  `[${label}] ${desc ?? ""}`.trim();
```

Persist the result by upserting on `(mcpServerId, originalName)`. Preserve the existing `enabled` and `cronSafe` flags on tools that already exist — a sync must never silently re-enable or disable anything the user configured. Tools that vanished from the server are deleted; tools that are new arrive with `enabled: false`.

## 5. Namespacing

```ts
export function toNamespacedName(serverSlug: string, toolName: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const full = `mcp__${clean(serverSlug)}__${clean(toolName)}`;
  if (full.length <= 64) return full;
  // Deterministic truncation: keep the prefix readable, keep uniqueness in a hash.
  const hash = createHash("sha1").update(full).digest("hex").slice(0, 6);
  return `${full.slice(0, 57)}_${hash}`;
}
```

Constraints and why they exist:

- **64 characters, `^[a-zA-Z0-9_-]+$`.** Provider tool-name validation. Exceeding either produces an API error on every request, not a degraded tool.

- **Truncation must be deterministic.** The name is stored in the database and must survive re-syncs unchanged, or enable/disable state detaches from the tool it belonged to.

- **Never parse the namespaced name to route a call.** Look up the `McpTool` row and use its `originalName` and `mcpServerId`. A server slug containing `__` would otherwise make parsing ambiguous.

This solves *name* collision only. Two tools that do the same job under different names — Composio's Figma toolkit and a Figma MCP server — is a *semantic* collision, and it is resolved by configuration, not code: see section 9.

## 6. Building the run-time ToolSet

This is the most important function in the feature. It runs inside `prepareAgentRun()` on every message, from every entry point, so it does no network I/O, holds no locks, and cannot throw.

```ts
export async function getOrCreateMcpTools(
  instanceId: string,
  source: MessageSource,
): Promise<ToolSet> {
  try {
    const rows = await db.mcpTool.findMany({
      where: {
        enabled: true,
        ...(source === "cron" ? { cronSafe: true } : {}),
        server: { instanceId, enabled: true },
      },
      include: { server: true },
    });

    const usable = rows.filter((r) =>
      isReachableHere(classifyReachability(r.server.url)),
    );

    const set: ToolSet = {};
    for (const row of usable) {
      set[row.namespacedName] = tool({
        description: row.description ?? undefined,
        inputSchema: jsonSchema(row.inputSchema as JSONSchema7),
        execute: async (args) => callMcpTool(row, args),
      });
    }
    return set;
  } catch (err) {
    logger.error({ err, instanceId }, "mcp: toolset assembly failed");
    return {}; // never break the run
  }
}
```

The lazy execute path, where the connection actually happens:

```ts
async function callMcpTool(row: McpToolWithServer, args: unknown) {
  try {
    const client = await getOrCreateMcpClient(row.server);
    const result = await withTimeout(
      client.callTool({ name: row.originalName, arguments: args }),
      CALL_TIMEOUT_MS,
    );
    return normalizeMcpResult(result);
  } catch (err) {
    await markServerFailed(row.mcpServerId, err);
    // Return, do not throw: the model can recover and try another approach.
    return { isError: true, message: describeError(err) };
  }
}
```

`normalizeMcpResult` flattens MCP content blocks into something the agent loop already handles: concatenate `text` blocks; convert `image` blocks the same way existing image results are handled; for `resource` blocks, inline small text resources and reduce the rest to a URI reference. If the result carries `isError: true`, pass it through as an error result rather than throwing.

Why the lazy design is worth the extra code:

- **No latency added to unused servers.** A project with a Figma server configured pays nothing on messages that never touch Figma. Eager `client.tools()` would open every connection on every message across web, Telegram, and both cron paths.

- **Rule 7 becomes structural.** There is no connection to fail during assembly, so "never throw in the hot path" stops being a discipline someone can forget.

- **The settings UI works offline.** Tool lists render from cached rows; adding a checkbox does not require the server to be up.

The cost is schema drift: a server can change its tools after the last sync. Handle it, do not prevent it — when `callTool` fails with an unknown-tool or invalid-arguments error, set `needsSync: true` on the server and let the UI surface "Sync needed". Do not auto-sync inside the execute path; that reintroduces network I/O into the hot path through the back door.

## 7. setup.ts — the three edits

Three lines change in `src/server/api/routers/nimits-jarvis/agent/setup.ts`. Nothing else in that file is touched.

```ts
// EDIT 1 — after L374 (getOrCreateSessionAndTools)
const rawMcpTools = await getOrCreateMcpTools(instanceId, source);

// EDIT 2 — replace L393 so MCP schemas are trimmed too
const optimized = optimizeToolSchemas({ ...rawComposioTools, ...rawMcpTools });

// EDIT 3 — L406-410, customTools MUST stay last
const allTools: ToolSet = wrapToolExecutors(
  { ...optimized, ...customTools },
  piiVault,
  restoreCache,
);
```

Hard constraints on these edits:

- **Do not call `wrapToolExecutors` twice.** It is the single point where PII redaction, token restoration in arguments, and result sanitization are applied. MCP tools inherit all of it by being inside this one call and by nothing else.

- **Do not widen `source: MessageSource`.** It stays the exact union from `setup.ts` L43 (`"web" | "telegram" | "cron"`). No new variant is needed — MCP configuration is instance-scoped, not per-message.

- **`customTools` stays last in the spread.** Later keys win, so this guarantees the always-available tools cannot be shadowed by a Composio or MCP tool of the same name.

- **MCP goes before `optimizeToolSchemas`, not after.** The existing call at L393 receives Composio tools only, which is why custom tools currently ship untrimmed. Do not replicate that mistake for MCP.

Nothing else in the agent needs to know MCP exists. There is no plugin interface to implement, no tool-source registry, no dispatch table. That is the point of matching the `ToolSet` shape.

## 8. tRPC procedures

Seven procedures under `src/server/api/routers/nimits-jarvis/`, each in its own file with a co-located `.schema.ts`, matching the existing convention (`getCronJobs.ts` + `getCronJobs.schema.ts`).

- `addMcpServer` — validate URL, derive nothing the user can override, encrypt headers, insert, then run a sync.

- `listMcpServers` — servers for an instance with derived reachability, tool counts, and `hasHeaders: boolean`. Never returns header values.

- `updateMcpServer` — label, URL, headers. Changing the URL clears `status` and sets `needsSync`.

- `deleteMcpServer` — cascade deletes tools; also evict the cached client.

- `toggleMcpServer` — flip `enabled`.

- `syncMcpTools` — run `discoverMcpTools`, upsert rows, preserve existing flags, clear `needsSync`.

- `toggleMcpTool` — flip a single tool's `enabled`, or `cronSafe`.

- `testMcpServer` — connect, write `status`/`lastError`/`lastSyncedAt`, return a summary. Mutation, not query — it has side effects.

Full example for the one with real logic:

```ts
// addMcpServer.schema.ts
export const addMcpServerSchema = z.object({
  instanceId: z.string().cuid(),
  label: z.string().min(1).max(60),
  name: z.string().regex(/^[a-z0-9-]{1,32}$/, "lowercase letters, numbers, hyphens"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

// addMcpServer.ts
export const addMcpServer = protectedProcedure
  .input(addMcpServerSchema)
  .mutation(async ({ ctx, input }) => {
    await assertInstanceOwnedByUser(ctx, input.instanceId);

    try {
      assertSafeMcpUrl(input.url);
    } catch (e) {
      throw new TRPCError({ code: "BAD_REQUEST", message: (e as Error).message });
    }

    const server = await ctx.db.mcpServer.create({
      data: {
        instanceId: input.instanceId,
        name: input.name,
        label: input.label,
        url: input.url,
        headersEnc: input.headers ? encrypt(JSON.stringify(input.headers)) : null,
      },
    });

    // Discover immediately so the UI has a tool list to show. Failure is not fatal:
    // the row exists and the user can retry with "Sync tools".
    try {
      await syncToolsForServer(server.id);
    } catch (err) {
      await markServerFailed(server.id, err);
    }

    return { id: server.id };
  });
```

`assertInstanceOwnedByUser` must exist on every one of these procedures. An MCP server row is a fetch target with attached credentials; letting one user write a row scoped to another user's instance is a confused-deputy bug, not a permissions nicety.

## 9. Settings UI

The UI is where semantic collision is resolved, so it is a functional requirement, not polish. It sits alongside the existing Composio connections panel in the project settings area and follows the same interaction model: a list of configured integrations, each expanding to a list of individual capabilities with checkboxes.

### 9.1 Files

One component per file, co-located skeletons, shadcn/ui primitives, no custom CSS beyond theme variables:

```
dashboard/_components/settings/mcp/
  mcp-servers-panel.tsx           // section wrapper + empty state
  mcp-servers-panel.skeleton.tsx
  mcp-server-row.tsx              // one configured server, collapsed
  mcp-server-tools-list.tsx       // expanded tool checkboxes
  add-mcp-server-dialog.tsx       // Dialog on desktop, Sheet on mobile
  mcp-reachability-badge.tsx
  mcp-status-badge.tsx
```

### 9.2 There is no local-versus-remote choice in the form

The add-server dialog has four fields and no transport selector:

- **Display name** — free text, e.g. "Vibe-trading", "Figma".

- **Slug** — auto-derived from the display name, editable, `^[a-z0-9-]{1,32}$`. Show the resulting tool prefix live beneath the field (`mcp__vibe-trading__…`) so the user understands what the model will see.

- **Server URL** — one field. `http://127.0.0.1:3845/mcp` and `https://mcp.example.com/mcp` go in the same box. As the user types, show the derived reachability badge inline; that is the entire local/remote distinction surfaced to the user.

- **Headers** — optional key/value rows, collapsed behind "Add authentication". Values are write-only: once saved the UI shows "Configured" with a Replace action, never the value.

On submit: validate, create, sync, and expand the new row with its tool list showing. If discovery failed, the row still appears with a failed status and a Retry action — never discard the user's input because a server was down.

### 9.3 Server row anatomy

Collapsed row, left to right: expand chevron, display name, reachability badge, status badge, tool count ("4 of 23 enabled"), overflow menu (Sync tools, Test connection, Edit, Delete), enable switch.

Reachability badge copy — this is the only place the user learns why a server is inert:

- `Local` — loopback address. Tooltip: "Only available when Jarvis runs on this machine."

- `Network` — private range. Tooltip: "Only available on your local network."

- `Remote` — public address. No tooltip needed.

When the runtime cannot reach a server's class of address, the row is visibly dimmed with the badge reading `Local — unavailable on this deployment`. Do not hide the row and do not silently disable the switch: the user configured it deliberately and needs to know why nothing is happening.

Status badge maps `McpServer.status`: `Connected` (green), `Failed` (destructive, with `lastError` in a tooltip), `Not tested` (muted), `Sync needed` (warning, shown when `needsSync` is true).

### 9.4 Tool list — the disambiguation surface

Expanding a row reveals its cached tools. Each line: checkbox, tool name (original, not namespaced — the prefix is noise to a human), truncated description, and a `cron` toggle.

Requirements:

- **Everything is off by default.** After adding a server the list shows 0 enabled. This is deliberate: discovery must never change what the model sees.

- **Show the running total across the whole project**, counting Composio tools too, pinned at the top of the panel: "31 tools enabled for this project". Past roughly 25 to 30, selection accuracy degrades measurably regardless of naming, so the number needs to be visible at the moment the user is adding more.

- **Warn on overlap.** If an enabled MCP tool's name or description strongly overlaps an enabled Composio toolkit for the same project, show an inline warning on the row: "Composio also provides Figma tools for this project. Enabling both makes tool selection ambiguous — disable one." A substring match on service names is sufficient; this is a nudge, not a classifier.

- **`Select all` per server**, with a confirmation when it would push the project total past 30.

- **`cron` toggle is per-tool and defaults off**, with a tooltip explaining that cron runs unattended with no human review. Hide it entirely for tools on a server the user has not enabled.

### 9.5 States and mobile

- **Empty state** — short explanation of what MCP adds plus a single "Add MCP server" button. Mention both cases in one line: "Connect a local server running on your machine, or a hosted one."

- **Loading** — the `.skeleton.tsx` files, matching the Composio panel's skeleton rhythm.

- **Syncing** — spinner on the row's Sync action, tool list dimmed but still readable; never blank it out.

- **Optimistic toggles** — checkbox state flips immediately, reverts with a toast on failure. Toggling is high-frequency during setup; waiting for a round trip per checkbox feels broken.

- **Mobile** — the panel is a stacked list; the add dialog becomes a slide-over Sheet, consistent with the rest of the dashboard.

## 10. Tool selection — what NOT to build

An implementer will be tempted to add routing logic that decides whether a request should go to Composio or to MCP. Do not build it. This section exists because that instinct is common and the resulting code is actively harmful.

Selection is already handled by the model. Function calling *is* routing: the model reads tool names and descriptions and picks. Inserting a classifier or keyword rules in front of it creates three failure modes that did not previously exist — a misclassified message hides a tool the model needed; the model then calls something unavailable and burns steps recovering; and there are now two selection systems that will disagree.

The correct division:

- **The system decides what is available.** Deterministic, message-independent: `enabled` flags, reachability, `cronSafe` against `source`, known-failed servers. Implemented as the `where` clause and filter in section 6 — nothing more.

- **The model decides what is called.** From names and descriptions only.

- **Overlap is resolved at configuration time**, by not enabling two tools for the same job (section 9.4).

Where overlap is unavoidable, descriptions are the only lever that works, which is why `prefixDescription` runs at discovery time. A `[Figma]` or `[Vibe-trading]` prefix on every tool description is worth more than any amount of prompt engineering elsewhere.

### 10.1 System prompt addition

`buildSystemPrompt()` (`setup.ts` L309-310) may take one sentence per enabled MCP server, describing what that server is for. One sentence. Not a decision tree, not usage rules, not examples.

```
Connected MCP servers for this project:

- Vibe-trading: local trading research and backtest tooling.

- Figma: read and modify design files in the team workspace.
```

Keep the whole block under roughly 50 tokens per server. Anything longer competes with the user's actual request for the model's attention and measurably degrades task performance. Derive the sentence from `McpServer.label` plus an optional user-supplied one-line purpose field; do not generate it.

Do not add instructions of the form "prefer MCP for X" or "use Composio when Y". If the model is picking the wrong tool, the fix is a better description or one fewer enabled tool — never a prompt rule.

## 11. Cron tiering

Cron is the only unattended path in the system: no human reviews a tool call before it executes, and cron jobs are already hardened against prompt injection through context isolation. A tool with side effects reaching that path is a different risk class from the same tool on the web path.

The mechanism is data, not a hardcoded list: `McpTool.cronSafe`, default `false`, surfaced as the per-tool `cron` toggle in the UI, applied as the `cronSafe: true` clause in section 6 when `source === "cron"`.

Guidance to show the user, and to apply when writing the macOS server in section 12:

- **Reasonable to mark cron-safe** — reads, queries, notifications, speech. Anything whose worst case is noise: `speak`, `notify`, `now_playing`, `get_clipboard`, market-data lookups, design-file reads.

- **Should not be cron-safe** — anything that sends a message to a third party, writes a file, changes application state, spends money, or mutates a shared document. `send_message`, `set_clipboard`, `open_app`, Figma write operations.

Blanket exclusion of all MCP tools from cron was considered and rejected: a scheduled 9 a.m. briefing spoken aloud on the host is one of the main reasons this feature is being built, and it is entirely safe. Tier by what the tool does, not by where the request came from.

## 12. The macOS control server (advanced)

This is the capability that motivates the feature: host control from every entry point, not just an open browser tab. `createMacTTS()` at `use-jarvis-voice.ts` L44 is a client component, so today Jarvis can only speak while a tab is focused; Telegram and cron runs cannot speak at all.

Build it as a **loopback HTTP MCP server**, not a stdio server. This is a deliberate reversal of the obvious approach and it matters:

- stdio would require child-process spawning inside the Next.js request path — command allowlists, environment scrubbing, process lifecycle, orphan cleanup, and a second connector code path.

- `scripts/cron-service.ts` already generates launchd LaunchAgents (`generatePlist`, `LAUNCH_AGENTS_DIR`, `loadService`). Emit a second plist for this server, have it listen on `127.0.0.1`, and Jarvis connects to it exactly like Vibe-trading. One connector, no spawning, and the capability is granted by a mechanism the project already uses and trusts.

Location: `scripts/mac-mcp/` with its own entry point, registered as an ordinary `McpServer` row pointing at `http://127.0.0.1:<port>/mcp`.

### 12.1 Verbs

Each verb takes typed, validated arguments and constructs its own `osascript` or shell invocation internally. Roughly 150 lines total.

```
speak(text: string)                  -> shells to `say`; cron-safe
notify(title: string, body: string)  -> system notification; cron-safe
now_playing()                        -> current track; cron-safe
get_clipboard()                      -> clipboard contents; cron-safe
set_volume(level: 0-100)             -> cron-safe
open_app(name: enum)                 -> allowlisted app names only; NOT cron-safe
set_clipboard(text: string)          -> NOT cron-safe
send_message(contact: enum, text)    -> allowlisted contacts only; NOT cron-safe
```

### 12.2 The rule that must not be relaxed

**No generic `run_applescript`, `run_shell`, `exec`, or `eval` tool. Ever. From any source.**

The reason is specific to this architecture rather than general caution. Composio Gmail feeds untrusted third-party text into the same agent loop. The attack is: someone emails the operator, Jarvis reads the message as a tool result, the message contains instructions to run a script, and the model executes it on the host. The PII vault provides no protection — it guards data flowing *out* to the model, not actions flowing *back in*.

The model must select a verb. It must never author code. `open_app` takes an enum, not a string; `send_message` resolves against an allowlist, not free-form input. Published macOS MCP servers overwhelmingly expose exactly the generic primitive this rule forbids, which is why this server is written in-repo rather than installed.

Bind to loopback only. This server must never listen on a routable interface.

### 12.3 Update the README when this ships

The README currently advertises "Zero Local Execution". Local execution already exists — the launchd LaunchAgent and cron daemon run on the host — but it is developer-directed. This change introduces model-directed host execution, which is a genuinely different risk class. Revise the claim rather than leaving a false security statement in the project's own documentation.

## 13. Verification

`scratch/verify-6-layer-llm-payload.ts` already calls `prepareAgentRun()` at L18 and is the fastest way to exercise the full pipeline outside the web app. Extend it rather than writing a new harness.

Assertions worth encoding:

- Every MCP tool key in the final toolset starts with `mcp__` and matches `^[a-zA-Z0-9_-]{1,64}$`.

- No MCP tool key collides with a Composio or custom tool key.

- Every MCP tool's `execute` is the wrapped version — assert that a tool result containing a known PII string comes back tokenized, proving the tools went through `wrapToolExecutors` and not around it.

- With `source: "cron"`, no tool whose `cronSafe` is false appears in the set.

- With a deliberately unreachable server configured, `getOrCreateMcpTools` returns `{}` and the run completes normally. This is the single most important test: it proves a misconfigured server cannot break a chat.

- On the Ollama path the vault is null and results are not tokenized — confirm this still holds and is not treated as a regression.

Manual checks: add a loopback server while running locally and confirm tools appear; deploy to Vercel and confirm the same row shows as unavailable and contributes no tools; stop the loopback server mid-session and confirm the next call fails gracefully, marks the server failed, and the chat continues.

## 14. Rollout order

Each phase leaves the system working. Do not reorder — phases 1 and 2 are what make the rest safe.

1. **Schema and helpers** — Prisma models, `mcp-url.ts`, crypto reuse. No behaviour change.
2. **Client module** — `mcp.ts` with connection cache, discovery, and `getOrCreateMcpTools` returning `{}` when nothing is configured. Still no behaviour change.
3. **The three `setup.ts` edits** — MCP tools can now reach the model, but no servers exist, so the toolset is identical to today. Verify with the harness that nothing changed.
4. **tRPC procedures** — configuration becomes possible via API before any UI exists. Test with a hand-inserted row pointing at a local server.
5. **Settings UI** — panel, rows, tool checkboxes, add dialog. This is the phase that makes the feature usable.
6. **Cron tiering** — `cronSafe` toggles and the filter, once there are real tools to tier.
7. **System-prompt sentences** — one line per server.
8. **macOS control server** — the loopback server and its launchd plist. Last, because it depends on everything above being correct.

Ship phases 1 through 5 before starting 8. The macOS server is the motivating use case, but it is also the highest-risk component, and it should be built on a connector path that is already proven with Vibe-trading and Figma.

---

## Appendix A — Deviations caught by Muse Spark (local verification, commit 07c21c4)

These supplement Part II where Opus 5 lacked filesystem access. All verified against live `setup.ts:652`, `tsconfig.json:22`, `prisma/schema.prisma:98`, `src/lib/crypto.ts:93`.

**A1. Path `src/server/lib/mcp-url.ts` → `src/lib/mcp-url.ts`.**
Repo has `src/lib/{crypto.ts, timezone.ts, server-only-shim.ts}` and no `src/server/lib/`. Keep Part II's file content but place it at `src/lib/mcp-url.ts` and import as `~/lib/mcp-url`.

**A2. `docs/` does not exist.**
`mkdir -p docs` before writing `docs/MCP_IMPLEMENTATION.md`.

**A3. `setup.ts:393` optimizer scope.**
Today `composioTools = optimizeToolSchemas(rawComposioTools)` and `customTools` stay raw. Part II §7 `const optimized = optimizeToolSchemas({ ...rawComposioTools, ...rawMcpTools })` preserves that — do not also optimize `customTools`.

**A4. `assertInstanceOwnedByUser` helper missing.**
`grep assertInstanceOwnedByUser → 0 hits`. Real helper is `getInstanceForUser(userId, instanceId)` in `src/server/api/routers/nimits-jarvis/utils.ts` (throws `FORBIDDEN`). Create `assertInstanceOwnedByUser` as a 3-line wrapper around it for §8 procedures.

**A5. Prisma back-relation.**
`ComposioClawInstance` at `schema.prisma:98` needs `mcpServers McpServer[]` or `prisma db push` fails (`no opposite field`).

**A6. Column name `headersEnc` vs `headersEncrypted`.**
Pick `headersEnc String?` as in §2 schema and keep it everywhere. `listMcpServers` returns `hasHeaders: boolean`.

**A7. Procedure count.**
§8 header says "Seven" but lists 8 (`add|list|update|delete|toggleServer|sync|toggleTool|test`). Implement 8.

**A8. `@modelcontextprotocol/sdk` v1 vs v2.**
`tsconfig.json:22` is already `bundler`, so `.js` subpath imports are valid. Do not invent `@modelcontextprotocol/client` (404). `experimental_createMCPClient` from `ai@6.0.78` may be missing in this exact version — probe `ai` exports first; fallback to `new Client + StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/*` if absent.

**A9. `src/server/api/root.ts:7` has 4 routers only.**
Register `mcp: mcpRouter` after creation.

**A10. Harness ghost ID.**
`scratch/verify-6-layer-llm-payload.ts:18` hard-codes a stale `instanceId`. Replace with `await db.composioClawInstance.findFirst()` before assertions.

**A11. `isReachableHere` pure function.**
Keep `process.env.VERCEL` check as spec §3; mock it in tests rather than branching in `getOrCreateMcpTools`.

**A12. Reachability UI on Vercel.**
Spec §9.3 dimming "Local — unavailable" is correct; do not `return null` or user loses the row.

