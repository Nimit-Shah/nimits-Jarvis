/**
 * browser-mcp-daemon — supervises Playwright MCP servers from McpServer rows.
 *
 * Owns: launch args (policy → CLI, all flags probe-verified), child lifecycle,
 * policy reload (policyVersion poll → rewrite + restart one child), and the
 * appliedPolicyVersion write-back the Settings UI reads as "Applying".
 *
 * CLI (not --config) is authoritative: every flag passed here was verified
 * against the installed @playwright/mcp. The per-server spec JSON in
 * browser-specs/ is a launch RECORD (includes the derived command string),
 * not an input — editing it changes nothing.
 *
 * Run: `pnpm browser:daemon` (foreground; SIGINT/SIGTERM stops children).
 */
import "dotenv/config";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync, type WriteStream } from "node:fs";
import { connect } from "node:net";
import { db } from "~/server/clients/db";
import { expandOriginPatterns } from "~/server/lib/browser/origins";
import { infraSeedFlat } from "~/server/lib/browser/infra-origins";
import { validateDedicatedProfileDir } from "~/server/lib/browser/profile-guard";

const POLL_MS = 5_000;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;
const KILL_TIMEOUT_MS = 8_000;
const PORT_WAIT_MS = 20_000;
const HEALTHY_AFTER_MS = 10_000;
const CRASH_BACKOFF_MS = 2_000;
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const LOG_KEEP = 3;
const LEGACY_ROOT = join(homedir(), ".jarvis");
const LEGACY_MIN_BYTES = 1 * 1024 * 1024;

type Supervised = {
  serverId: string;
  slug: string;
  child: ChildProcess | null;
  policyVersion: number;
  restarts: number[];
  stopped: boolean;
  gaveUp: boolean;
  startToken: number;
  port: number;
};

const supervised = new Map<string, Supervised>();

function appSupportRoot(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "NimitsJarvis");
  if (platform() === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "NimitsJarvis");
  return join(homedir(), ".local", "share", "nimits-jarvis");
}

function browserRoot(): string {
  return join(appSupportRoot(), "browser");
}

function defaultProfileDir(slug: string): string {
  return join(browserRoot(), slug);
}

function specsDir(): string {
  return join(browserRoot(), "specs");
}

function logPath(slug: string): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Logs", "NimitsJarvis", `browser-${slug}.log`);
  return join(browserRoot(), "logs", `browser-${slug}.log`);
}

/** Resolve the pinned @playwright/mcp CLI (devDependency, exact version). */
function mcpCliEntry(): string {
  const req = createRequire(import.meta.url);
  const pkgPath = req.resolve("@playwright/mcp/package.json");
  return join(dirname(pkgPath), "cli.js");
}

function portFromUrl(raw: string): number | null {
  try {
    const u = new URL(raw);
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1" && u.hostname !== "::1") return null;
    const p = Number(u.port);
    return Number.isInteger(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Logging (per-server file, 10 MB x 3 rotation, console mirror in foreground)
// ---------------------------------------------------------------------------

function rotateLog(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size < LOG_MAX_BYTES) return;
    try {
      unlinkSync(`${path}.${LOG_KEEP}`);
    } catch { /* absent */ }
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      try {
        renameSync(`${path}.${i}`, `${path}.${i + 1}`);
      } catch { /* absent */ }
    }
    renameSync(path, `${path}.1`);
  } catch (err) {
    console.error(`[browser-daemon] log rotation failed for ${path}`, err);
  }
}

function attachLogging(child: ChildProcess, slug: string): void {
  const path = logPath(slug);
  mkdirSync(dirname(path), { recursive: true });
  rotateLog(path);
  const file: WriteStream = createWriteStream(path, { flags: "a" });
  const write = (chunk: Buffer | string) => {
    rotateLog(path);
    file.write(chunk);
    process.stdout.write(chunk);
  };
  child.stdout?.on("data", write);
  child.stderr?.on("data", write);
  child.on("exit", () => file.end());
}

// ---------------------------------------------------------------------------
// Preflight — one coherent refusal report before any child spawns
// ---------------------------------------------------------------------------

type ServerRow = {
  id: string;
  name: string;
  url: string;
  originMode: string;
  browserMode: string;
  browserChannel: string | null;
  executablePath: string | null;
  userDataDir: string | null;
  cdpEndpoint: string | null;
  cdpConfirmed: boolean;
  extensionConfirmed: boolean;
  headless: boolean;
  noSandbox: boolean;
  infraSeedEnabled: boolean;
  infraSeedExcluded: string[];
};

function dirBytes(path: string): number {
  try {
    const out = execSync(`du -sk ${JSON.stringify(path)}`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
    return Number(out.split(/\s/, 1)[0]) * 1024 || 0;
  } catch {
    return 0;
  }
}

function legacyProfiles(): Array<{ path: string; reason: string; bytes: number }> {
  const found: Array<{ path: string; reason: string; bytes: number }> = [];
  let entries: string[] = [];
  try {
    entries = execSync(`ls ${JSON.stringify(LEGACY_ROOT)}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!e.startsWith("browser-profile-")) continue;
    const p = join(LEGACY_ROOT, e);
    const hasCookies = existsSync(join(p, "Default", "Cookies"));
    const bytes = dirBytes(p);
    if (hasCookies || bytes >= LEGACY_MIN_BYTES) {
      found.push({ path: p, reason: hasCookies ? "contains Default/Cookies" : `${Math.round(bytes / 1048576)} MB on disk`, bytes });
    }
  }
  return found;
}

function portHolder(port: number): { pid: string; comm: string; args: string } | null {
  try {
    const pid = execSync(`lsof -ti:${port}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n")[0]?.trim();
    if (!pid) return null;
    let comm = "";
    let args = "";
    try {
      comm = execSync(`ps -o comm= -p ${pid}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      args = execSync(`ps -o args= -p ${pid}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().slice(0, 200);
    } catch { /* unknown */ }
    return { pid, comm, args };
  } catch {
    return null;
  }
}

/** Kill a stale Playwright MCP orphan so it can't wedge the port forever. */
function reapMcpOrphan(holder: { pid: string; args: string }): boolean {
  if (!/@playwright\/mcp|playwright-mcp/i.test(holder.args)) {
    console.log(`[browser-daemon] port holder ${holder.pid} is not a Playwright MCP process — leaving it alone.`);
    return false;
  }
  try {
    process.kill(-Number(holder.pid), "SIGTERM");
    console.log(`[browser-daemon] reaped stale Playwright MCP process ${holder.pid}.`);
    return true;
  } catch (err) {
    console.error(`[browser-daemon] could not reap Playwright MCP process ${holder.pid}`, err);
    return false;
  }
}

async function preflight(servers: ServerRow[]): Promise<string[]> {
  const problems: string[] = [];

  const legacy = legacyProfiles();
  for (const l of legacy) {
    const slug = l.path.split("/").at(-1)?.replace(/^browser-profile-/, "") ?? "<slug>";
    problems.push(
      [
        `Legacy profile outside the protected tree: ${l.path} (${l.reason}).`,
        `  This directory holds live session cookies and is readable by fs_read.`,
        `  Migrate (keeps logins):`,
        `    mkdir -p ${join(appSupportRoot(), "browser").replace(/ /g, "\\ ")}`,
        `    mv ${l.path.replace(/ /g, "\\ ")} ${join(browserRoot(), slug).replace(/ /g, "\\ ")}`,
        `  Or discard (you will re-login):`,
        `    rm -rf ${l.path.replace(/ /g, "\\ ")}`,
      ].join("\n"),
    );
  }

  for (const s of servers) {
    const port = portFromUrl(s.url);
    if (port === null) {
      problems.push(`${s.name}: only loopback URLs are supervised (got ${s.url}).`);
      continue;
    }
    const holder = portHolder(port);
    if (holder && !reapMcpOrphan(holder)) {
      problems.push(`${s.name}: port ${port} is held by an unrelated process (${holder.pid}${holder.comm ? ` ${holder.comm}` : ""}) — free it or change the server URL.`);
    }
    if (s.originMode === "allowlist") {
      const n = await db.mcpOriginRule.count({ where: { mcpServerId: s.id, enabled: true, kind: "allow" } });
      if (n === 0) {
        problems.push(`${s.name}: allowlist mode is on but no origins are allowed — add at least one site or switch to Open.`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Launch-spec assembly
// ---------------------------------------------------------------------------

export async function buildArgs(server: ServerRow): Promise<{ args: string[]; spec: Record<string, unknown> } | { error: string }> {
  const port = portFromUrl(server.url);
  if (port === null) return { error: `Only loopback URLs are supervised (got ${server.url}).` };

  const args = ["--port", String(port), "--timeout-navigation", "60000"];
  // Vision capability: screenshot/file tools return inline image blocks.
  // Jarvis persists them into MessageAttachment (origin "mcp") so vision
  // models can analyze them; without this flag only server-side paths come
  // back and the model stays blind.
  args.push("--caps", "vision");
  // No --no-sandbox by default: it exists for Docker/root, not for a
  // normal-user Mac driving a logged-in browser. Explicit opt-in only.
  if (server.noSandbox) args.push("--no-sandbox");
  // No --headless for attached modes (cdp/extension): there is no launched
  // browser to head.
  if (server.headless && server.browserMode !== "cdp" && server.browserMode !== "extension") args.push("--headless");
  if (server.browserMode === "channel") args.push("--browser", server.browserChannel ?? "chrome");
  else if (server.browserMode === "executable") {
    if (!server.executablePath) return { error: "browserMode executable needs executablePath." };
    args.push("--executable-path", server.executablePath);
  } else if (server.browserMode === "cdp") {
    if (!server.cdpEndpoint || !server.cdpConfirmed) return { error: "CDP needs cdpEndpoint + explicit confirmation." };
    args.push("--cdp-endpoint", server.cdpEndpoint);
  } else if (server.browserMode === "extension") {
    // Extension bridge: drives the OPEN Comet/Chrome (live profile + logins)
    // via the Playwright extension. Token comes from env
    // (PLAYWRIGHT_MCP_EXTENSION_TOKEN) — never args, never the spec record.
    // No userDataDir: the live profile is the point. Same risk class as CDP.
    if (!process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN) {
      return { error: "Extension mode needs PLAYWRIGHT_MCP_EXTENSION_TOKEN in the daemon environment (.env) — see .env.example." };
    }
    if (!server.extensionConfirmed) return { error: "Extension mode needs explicit confirmation (live browser with your logins)." };
    // The relay locates the extension in the DEFAULT profile dir of the
    // resolved browser (Chrome's tree unless told otherwise). Comet users
    // must set executablePath to the Comet binary so it looks in Comet's
    // tree instead — otherwise "Extension not found" (verified live).
    if (server.executablePath) args.push("--executable-path", server.executablePath);
    args.push("--extension");
  } else {
    args.push("--browser", "chrome");
  }

  if (server.browserMode !== "cdp" && server.browserMode !== "extension") {
    const dir = server.userDataDir ?? defaultProfileDir(server.name);
    const check = validateDedicatedProfileDir(dir);
    if (!check.ok) return { error: check.message };
    mkdirSync(check.real, { recursive: true });
    args.push("--user-data-dir", check.real);
  }

  const allowed: string[] = [];
  const blocked: string[] = [];
  if (server.originMode === "allowlist") {
    const rules = await db.mcpOriginRule.findMany({ where: { mcpServerId: server.id, enabled: true } });
    // Layer 1 — shared infrastructure seed (asset CDNs only; never
    // analytics/ads). Not rows: versions with the repo, disabled via
    // infraSeedExcluded. Duplicates with Layer 2 are harmless.
    const seed = server.infraSeedEnabled ? infraSeedFlat().filter((s) => !server.infraSeedExcluded.includes(s)) : [];
    for (const entry of seed) {
      try {
        allowed.push(...expandOriginPatterns(entry));
      } catch {
        console.warn(`[browser-daemon] skipping invalid seed entry: ${entry}`);
      }
    }
    // Layer 2 — per-site rules, unchanged.
    for (const r of rules) {
      try {
        const expanded = expandOriginPatterns(r.pattern);
        (r.kind === "block" ? blocked : allowed).push(...expanded);
      } catch {
        console.warn(`[browser-daemon] skipping invalid rule pattern: ${r.pattern}`);
      }
    }
    // Fail closed on SITE rules only: the seed is infrastructure, not
    // permission to browse — it must never satisfy this check.
    const siteAllows = rules.filter((r) => r.kind === "allow").length;
    if (siteAllows === 0) {
      return { error: "Allowlist mode is on but no origins are allowed — add at least one site or switch to Open." };
    }
    const sets = { allowed: [...new Set(allowed)], blocked: [...new Set(blocked)] };
    args.push("--allowed-origins", sets.allowed.join(";"));
    if (sets.blocked.length > 0) args.push("--blocked-origins", sets.blocked.join(";"));
    const spec = {
      note: "Launch RECORD — CLI is authoritative; editing this file changes nothing.",
      command: `node ${mcpCliEntry()} ${args.join(" ")}`,
      port,
      originMode: server.originMode,
      allowed: sets.allowed,
      blocked: sets.blocked,
      browserMode: server.browserMode,
      generatedAt: new Date().toISOString(),
    };
    return { args, spec };
  }

  const cliJs = mcpCliEntry();
  const spec = {
    note: "Launch RECORD — CLI is authoritative; editing this file changes nothing.",
    command: `node ${cliJs} ${args.join(" ")}`,
    port,
    originMode: server.originMode,
    allowed,
    blocked,
    browserMode: server.browserMode,
    generatedAt: new Date().toISOString(),
  };
  return { args, spec };
}

// ---------------------------------------------------------------------------
// Supervision
// ---------------------------------------------------------------------------

function startChild(s: Supervised, cliJs: string, args: string[], spec: Record<string, unknown>, port: number): void {
  const dir = specsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${s.slug}.json`), JSON.stringify(spec, null, 2));
  console.log(`[browser-daemon] starting ${s.slug}: node ${cliJs} ${args.join(" ")} (log: ${logPath(s.slug)})`);
  // detached: own process group so a kill takes the wrapper AND its node
  // grandchildren (otherwise the orphan keeps the port → EADDRINUSE loop).
  const child = spawn(process.execPath, [cliJs, ...args], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  s.child = child;
  attachLogging(child, s.slug);
  const startToken = (s.policyVersion << 16) | (Date.now() % 65536);
  s.startToken = startToken;
  child.on("exit", (code) => {
    if (s.child !== child) return;
    s.child = null;
    if (s.stopped) return;
    const now = Date.now();
    s.restarts = [...s.restarts.filter((t) => now - t < RESTART_WINDOW_MS), now];
    if (s.restarts.length > MAX_RESTARTS) {
      console.error(`[browser-daemon] ${s.slug} crashed ${s.restarts.length}x in 60s — giving up until next policy change.`);
      s.gaveUp = true;
      return;
    }
    console.log(`[browser-daemon] ${s.slug} exited (${code}) — restarting in ${CRASH_BACKOFF_MS}ms.`);
    setTimeout(() => {
      if (!s.stopped) startChild(s, cliJs, args, spec, port);
    }, CRASH_BACKOFF_MS);
  });
  // Confirm health: only mark the policy applied once OUR child survives.
  setTimeout(() => {
    void (async () => {
      if (s.stopped || s.child !== child || child.exitCode !== null || s.startToken !== startToken) return;
      const free = await isPortFree(port);
      if (!free) {
        await db.mcpServer.update({
          where: { id: s.serverId },
          data: { appliedPolicyVersion: s.policyVersion, status: "ok", lastError: null },
        });
      }
    })().catch((err) => console.error("[browser-daemon] health confirm failed", err));
  }, HEALTHY_AFTER_MS);
}

function probeHost(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(port, host);
    sock.on("connect", () => {
      sock.destroy();
      resolve(false);
    });
    sock.on("error", () => resolve(true));
  });
}

async function isPortFree(port: number): Promise<boolean> {
  // Probe both stacks: the MCP server may bind ::1 only, in which case a
  // 127.0.0.1 probe falsely reports free (this once wedged appliedPolicyVersion).
  return (await probeHost(port, "127.0.0.1")) && (await probeHost(port, "::1"));
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortFree(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function stopChild(s: Supervised): Promise<void> {
  s.stopped = true;
  const child = s.child;
  s.child = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    setTimeout(() => resolve(), KILL_TIMEOUT_MS);
  });
  try {
    // Negative pid = whole process group (wrapper + node grandchildren).
    process.kill(-(child.pid ?? 0), "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
  }
  await exited;
  try {
    if (child.exitCode === null) process.kill(-(child.pid ?? 0), "SIGKILL");
  } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 1000));
}

async function reconcile(): Promise<void> {
  const servers = await db.mcpServer.findMany({ where: { serverType: "playwright", enabled: true } });
  const seen = new Set<string>();

  for (const server of servers) {
    seen.add(server.id);
    const existing = supervised.get(server.id);
    if (existing && existing.policyVersion === server.policyVersion) {
      if (existing.child) continue;
      if (existing.gaveUp) continue;
    }

    if (existing) {
      console.log(`[browser-daemon] policy v${server.policyVersion} for ${server.name} — restarting (session will reset; logins in the dedicated profile persist).`);
      await stopChild(existing);
      existing.stopped = false;
      existing.gaveUp = false;
    }
    const built = await buildArgs(server);
    if ("error" in built) {
      console.error(`[browser-daemon] ${server.name}: ${built.error}`);
      await db.mcpServer.update({ where: { id: server.id }, data: { status: "failed", lastError: built.error } });
      continue;
    }
    const port = portFromUrl(server.url) ?? 0;
    const entry: Supervised = existing ?? {
      serverId: server.id,
      slug: server.name,
      child: null,
      policyVersion: 0,
      restarts: [],
      stopped: false,
      gaveUp: false,
      startToken: 0,
      port,
    };
    entry.policyVersion = server.policyVersion;
    entry.port = port;
    supervised.set(server.id, entry);
    let free = await waitForPortFree(port, PORT_WAIT_MS);
    if (!free) {
      // A stale MCP orphan from a crashed daemon wedges the port forever —
      // reap it once (Playwright MCP processes only, never anything else).
      const holder = portHolder(port);
      if (holder && reapMcpOrphan(holder)) free = await waitForPortFree(port, PORT_WAIT_MS);
    }
    if (!free) {
      console.error(`[browser-daemon] ${server.name}: port ${port} still busy — will retry on next poll.`);
      continue;
    }
    startChild(entry, mcpCliEntry(), built.args, built.spec, port);
  }

  for (const [id, s] of supervised) {
    if (!seen.has(id)) {
      console.log(`[browser-daemon] ${s.slug} no longer supervised — stopping.`);
      await stopChild(s);
      supervised.delete(id);
    }
  }
}

async function main(): Promise<void> {
  console.log("[browser-daemon] watching playwright-type MCP servers (poll 5s).");
  const servers = await db.mcpServer.findMany({ where: { serverType: "playwright", enabled: true } });
  const blockers = await preflight(servers);
  if (blockers.length > 0) {
    console.error("[browser-daemon] Refusing to start:\n\n" + blockers.map((b) => `  ${b}`).join("\n\n"));
    await db.$disconnect();
    process.exit(1);
  }
  const loop = async () => {
    try {
      await reconcile();
    } catch (err) {
      console.error("[browser-daemon] reconcile failed", err);
    }
    setTimeout(() => void loop(), POLL_MS);
  };
  const shutdown = () => {
    console.log("[browser-daemon] shutting down.");
    void (async () => {
      for (const s of supervised.values()) await stopChild(s);
      await db.$disconnect().finally(() => process.exit(0));
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await loop();
}

// Entrypoint only when run directly (`pnpm browser:daemon`) — importable
// for unit tests (buildArgs) without side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
