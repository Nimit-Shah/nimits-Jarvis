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
 * Single-instance per machine (daemon.lock refuses a second copy), stdout
 * mirrored to a daily browser-daemon-*.log next to the per-slug child logs.
 */
import "dotenv/config";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, type WriteStream } from "node:fs";
import { connect } from "node:net";
import { format } from "node:util";
import { db } from "~/server/clients/db";
import { expandOriginPatterns } from "~/server/lib/browser/origins";
import { infraSeedFlat } from "~/server/lib/browser/infra-origins";
import { browserTargetFor } from "~/server/lib/browser/browser-target";
import { validateDedicatedProfileDir } from "~/server/lib/browser/profile-guard";

const POLL_MS = 5_000;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;
const KILL_TIMEOUT_MS = 8_000;
const PORT_WAIT_MS = 20_000;
const HEALTHY_AFTER_MS = 10_000;
// Policy settle window: rapid re-saves coalesce into ONE restart once quiet.
// (Without this, every save arms a restart and each one clears gaveUp —
// the batch-of-5 crash pattern from the EADDRINUSE RCA.)
const SETTLE_MS = 15_000;
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const LOG_KEEP = 3;
const LEGACY_ROOT = join(homedir(), ".jarvis");
const LEGACY_MIN_BYTES = 1 * 1024 * 1024;

type Supervised = {
  groupKey: string;
  port: number;
  ownerId: string;
  participantIds: string[];
  policyVersions: Record<string, number>;
  policyHash: string;
  slug: string;
  child: ChildProcess | null;
  restarts: number[];
  stopped: boolean;
  gaveUp: boolean;
  startToken: number;
  // Settle bookkeeping: a policy bump records lastBumpAt + arms
  // restartPending; the restart fires once quiet (see reconcile).
  lastBumpAt: number;
  restartPending: boolean;
};

const supervised = new Map<string, Supervised>();

// Refusal signatures for shared-target groups (log + mark failed once per
// exact member set; cleared when the group goes back to a single row).
const refusedSignatures = new Map<string, string>();

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

function daemonLogPath(): string {
  const day = new Date().toISOString().slice(0, 10);
  if (platform() === "darwin") return join(homedir(), "Library", "Logs", "NimitsJarvis", `browser-daemon-${day}.log`);
  return join(browserRoot(), "logs", `browser-daemon-${day}.log`);
}

/**
 * Mirror the daemon's OWN stdout/stderr to a daily file (children already
 * log per-slug). The EADDRINUSE RCA stalled for lack of exactly this record —
 * terminal scrollback is not evidence. Never throws: logging must not kill
 * supervision. Daily files, no size rotation (reconcile is quiet when idle).
 */
function teeDaemonOutput(): void {
  const path = daemonLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const file = createWriteStream(path, { flags: "a" });
    file.on("error", () => undefined);
    for (const method of ["log", "warn", "error"] as const) {
      const orig = console[method].bind(console);
      console[method] = (...args: unknown[]) => {
        orig(...args);
        try {
          file.write(`[${new Date().toISOString()}] ${format(...args)}\n`);
        } catch { /* never fail supervision over logging */ }
      };
    }
  } catch { /* never fail supervision over logging */ }
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
  policyVersion: number;
  createdAt: Date;
};

type RuleRow = { pattern: string; kind: string };

type Group = {
  key: string;
  port: number;
  owner: ServerRow;
  members: ServerRow[];
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
    // LISTEN only: an ESTABLISHED client socket (e.g. Jarvis itself holding
    // a dead session) must never block or doom supervision.
    const pid = execSync(`lsof -ti:${port} -sTCP:LISTEN`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n")[0]?.trim();
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
    // NOTE: per-row policy problems (e.g. allowlist mode with zero rules)
    // are NOT preflight blockers: reconcile marks those rows failed
    // individually. A single misconfigured row must never silence healthy
    // rows by refusing the whole daemon.
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Launch-spec assembly
// ---------------------------------------------------------------------------

export async function buildArgs(server: ServerRow): Promise<{ args: string[]; spec: Record<string, unknown> } | { error: string }> {
  const rules = await db.mcpOriginRule.findMany({ where: { mcpServerId: server.id, enabled: true } });
  return buildGroupArgs(server, [server], new Map([[server.id, rules]]));
}

/** Group key: canonical target base + mode class (a managed and an
 * extension child on one port are different lifecycles — and the per-port
 * collision guard refuses the loser). Exported for the agreement unit test:
 * mutex key, write guard, and this base must never disagree. */
export function groupKeyFor(server: ServerRow): string | null {
  if (server.browserMode === "cdp") {
    return browserTargetFor(server);
  }
  const port = portFromUrl(server.url);
  if (port === null) return null;
  const cls = server.browserMode === "extension" ? "ext" : "managed";
  return `port:${port}:${cls}`;
}

function groupServers(servers: ServerRow[]): Group[] {
  const byKey = new Map<string, ServerRow[]>();
  for (const s of servers) {
    const key = groupKeyFor(s);
    if (key === null) continue;
    const list = byKey.get(key) ?? [];
    list.push(s);
    byKey.set(key, list);
  }
  const groups: Group[] = [];
  for (const [key, members] of byKey) {
    const sorted = [...members].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const owner = sorted[0]!;
    const port = owner.browserMode === "cdp" ? (portFromUrl(owner.url) ?? 0) : Number(key.split(":")[1]);
    groups.push({ key, port, owner, members: sorted });
  }
  return groups;
}

function policyHashFor(members: ServerRow[]): string {
  return members
    .map((m) => `${m.id}:${m.policyVersion}`)
    .sort()
    .join("|");
}

export async function buildGroupArgs(
  owner: ServerRow,
  members: ServerRow[],
  rulesByServer: Map<string, RuleRow[]>,
): Promise<{ args: string[]; spec: Record<string, unknown> } | { error: string }> {
  const port = portFromUrl(owner.url);
  if (port === null) return { error: `Only loopback URLs are supervised (got ${owner.url}).` };

  const args = ["--port", String(port), "--timeout-navigation", "60000"];
  // Vision capability: screenshot/file tools return inline image blocks.
  // Jarvis persists them into MessageAttachment (origin "mcp") so vision
  // models can analyze them; without this flag only server-side paths come
  // back and the model stays blind.
  args.push("--caps", "vision");
  // Sandbox: strictest wins across managed members. A shared child cannot
  // be sandboxed for one participant and not another. Overridden = rows
  // that wanted it off but lost the vote.
  const managed = members.filter((m) => m.browserMode !== "cdp" && m.browserMode !== "extension");
  const sandboxOffEverywhere = managed.length > 0 && managed.every((m) => m.noSandbox);
  if (sandboxOffEverywhere) args.push("--no-sandbox");
  const sandboxOverridden = sandboxOffEverywhere ? [] : managed.filter((m) => m.noSandbox).map((m) => m.id);
  // No --headless for attached modes (cdp/extension): there is no launched
  // browser to head.
  if (owner.headless && owner.browserMode !== "cdp" && owner.browserMode !== "extension") args.push("--headless");
  if (owner.browserMode === "channel") args.push("--browser", owner.browserChannel ?? "chrome");
  else if (owner.browserMode === "executable") {
    if (!owner.executablePath) return { error: `browserMode executable needs executablePath (${owner.name}).` };
    args.push("--executable-path", owner.executablePath);
  } else if (owner.browserMode === "cdp") {
    if (!owner.cdpEndpoint) return { error: `CDP needs cdpEndpoint (${owner.name}).` };
    if (!members.some((m) => m.cdpConfirmed)) {
      return { error: `CDP needs explicit confirmation on at least one row sharing ${owner.cdpEndpoint}.` };
    }
    args.push("--cdp-endpoint", owner.cdpEndpoint);
  } else if (owner.browserMode === "extension") {
    // Extension bridge: drives the OPEN Comet/Chrome (live profile + logins)
    // via the Playwright extension. Token comes from env
    // (PLAYWRIGHT_MCP_EXTENSION_TOKEN) — never args, never the spec record.
    // No userDataDir: the live profile is the point. Same risk class as CDP.
    if (!process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN) {
      return { error: "Extension mode needs PLAYWRIGHT_MCP_EXTENSION_TOKEN in the daemon environment (.env) — see .env.example." };
    }
    if (!members.some((m) => m.extensionConfirmed)) {
      return { error: "Extension mode needs explicit confirmation on at least one participating row (live browser with your logins)." };
    }
    // The relay locates the extension in the DEFAULT profile dir of the
    // resolved browser (Chrome's tree unless told otherwise). Comet users
    // must set executablePath to the Comet binary so it looks in Comet's
    // tree instead — otherwise "Extension not found" (verified live).
    if (owner.executablePath) args.push("--executable-path", owner.executablePath);
    args.push("--extension");
  } else {
    args.push("--browser", "chrome");
  }

  if (owner.browserMode !== "cdp" && owner.browserMode !== "extension") {
    const dir = owner.userDataDir ?? defaultProfileDir(owner.name);
    const check = validateDedicatedProfileDir(dir);
    if (!check.ok) return { error: check.message };
    mkdirSync(check.real, { recursive: true });
    args.push("--user-data-dir", check.real);
  }

  const allowed: string[] = [];
  const blocked: string[] = [];
  const allowlistMembers = members.filter((m) => m.originMode === "allowlist");
  if (allowlistMembers.length > 0) {
    // Layer 1 — seed union: an entry applies unless every allowlist member
    // excluded it. Layer 2 — per-site rules unioned across members.
    // Deny wins globally: a shared child cannot honour a block for one
    // participant and not another.
    const seedVotes = new Map<string, number>();
    for (const m of allowlistMembers) {
      if (!m.infraSeedEnabled) continue;
      for (const entry of infraSeedFlat()) {
        if (m.infraSeedExcluded.includes(entry)) continue;
        seedVotes.set(entry, (seedVotes.get(entry) ?? 0) + 1);
      }
    }
    for (const entry of seedVotes.keys()) {
      try {
        allowed.push(...expandOriginPatterns(entry));
      } catch {
        console.warn(`[browser-daemon] skipping invalid seed entry: ${entry}`);
      }
    }
    for (const m of allowlistMembers) {
      for (const r of rulesByServer.get(m.id) ?? []) {
        try {
          const expanded = expandOriginPatterns(r.pattern);
          (r.kind === "block" ? blocked : allowed).push(...expanded);
        } catch {
          console.warn(`[browser-daemon] skipping invalid rule pattern: ${r.pattern}`);
        }
      }
    }
    // Fail closed on SITE rules only: the seed is infrastructure, not
    // permission to browse — it must never satisfy this check.
    const siteAllows = allowlistMembers.reduce(
      (n, m) => n + (rulesByServer.get(m.id) ?? []).filter((r) => r.kind === "allow").length,
      0,
    );
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
      ownerServerId: owner.id,
      participantServerIds: members.map((m) => m.id),
      sandboxOverridden,
      allowed: sets.allowed,
      blocked: sets.blocked,
      generatedAt: new Date().toISOString(),
    };
    return { args, spec };
  }

  const cliJs = mcpCliEntry();
  const spec = {
    note: "Launch RECORD — CLI is authoritative; editing this file changes nothing.",
    command: `node ${cliJs} ${args.join(" ")}`,
    port,
    ownerServerId: owner.id,
    participantServerIds: members.map((m) => m.id),
    sandboxOverridden,
    allowed,
    blocked,
    generatedAt: new Date().toISOString(),
  };
  return { args, spec };
}

// ---------------------------------------------------------------------------
// Single-instance guard — one daemon per machine, full stop.
//
// browserRoot is machine-global and the daemon supervises every project's
// rows in one poll loop, so the lockfile is global too. A second daemon
// would fight the first over ports (reapMcpOrphan cannot tell a supervised
// child from an orphan) — the EADDRINUSE storm mechanism from the RCA.
// The lockfile records which repo owns the live daemon so a refusal in a
// second checkout names what to stop. Stale locks (crashed daemon) are
// overridden via kill(pid, 0); EPERM means alive-but-unowned → refuse.
// ---------------------------------------------------------------------------

export type DaemonLock = { pid: number; repoPath: string; startedAt: string };

function daemonLockPath(root: string = browserRoot()): string {
  return join(root, "daemon.lock");
}

export function acquireDaemonLock(root?: string): { ok: true } | { ok: false; holder: DaemonLock } {
  const path = daemonLockPath(root ?? browserRoot());
  mkdirSync(dirname(path), { recursive: true });
  let raw: string | null = null;
  try {
    raw = readFileSync(path, "utf8");
  } catch { /* absent → free */ }
  if (raw) {
    let stale = true;
    let holder: DaemonLock | null = null;
    try {
      const parsed = JSON.parse(raw) as DaemonLock;
      if (parsed && typeof parsed.pid === "number") {
        holder = parsed;
        try {
          process.kill(parsed.pid, 0);
          stale = false; // no signal sent; process exists
        } catch (err) {
          // ESRCH/ENOENT = dead → stale, override. EPERM = alive → refuse.
          stale = (err as NodeJS.ErrnoException)?.code !== "EPERM";
        }
      }
    } catch { /* unparseable → stale, override */ }
    if (!stale && holder) return { ok: false, holder };
  }
  const lock: DaemonLock = { pid: process.pid, repoPath: process.cwd(), startedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(lock, null, 2));
  return { ok: true };
}

export function releaseDaemonLock(root?: string): void {
  const path = daemonLockPath(root ?? browserRoot());
  try {
    const raw = readFileSync(path, "utf8");
    const holder = JSON.parse(raw) as DaemonLock;
    if (holder?.pid !== process.pid) return; // not ours — leave it
    unlinkSync(path);
  } catch { /* absent/unparseable — nothing to release */ }
}

// ---------------------------------------------------------------------------
// Crash accounting (pure — pinned by unit test).
//
// Reconcile owns ALL child starts behind waitForPortFree; the exit handler
// only records. Identity-guarded: a stale child's exit against a
// re-populated entry must never trip gaveUp on a healthy generation.
// ---------------------------------------------------------------------------

export type CrashOutcome = "ignore" | "recover" | "give-up";

export function crashDecision(
  entry: { child: unknown; stopped: boolean; restarts: number[] },
  exited: unknown,
  now: number,
): { outcome: CrashOutcome; restarts: number[] } {
  if (entry.child !== exited || entry.stopped) return { outcome: "ignore", restarts: entry.restarts };
  const restarts = [...entry.restarts.filter((t) => now - t < RESTART_WINDOW_MS), now];
  if (restarts.length > MAX_RESTARTS) return { outcome: "give-up", restarts };
  return { outcome: "recover", restarts };
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
  // Record the pid in the spec so crash recovery (and operators) know what
  // this group was running.
  try {
    writeFileSync(join(dir, `${s.slug}.json`), JSON.stringify({ ...spec, childPid: child.pid ?? null }, null, 2));
  } catch { /* best effort */ }
  const startToken = Date.now() % 2147483647;
  s.startToken = startToken;
  child.on("exit", (code) => {
    // Reconcile owns every start behind waitForPortFree — this handler only
    // records. A blind timer-restart here is what turned one transient
    // collision into an EADDRINUSE storm (no port check on that path).
    const { outcome, restarts } = crashDecision(s, child, Date.now());
    s.restarts = restarts;
    if (outcome === "ignore") return;
    s.child = null;
    if (outcome === "give-up") {
      console.error(`[browser-daemon] ${s.slug} crashed ${s.restarts.length}x in 60s — giving up until next settled policy change.`);
      s.gaveUp = true;
      // Surface the give-up on the rows: a crash-looping child (e.g. CDP
      // endpoint with nothing listening) must read as failed, never as ok.
      // No fallback is ever launched — the error names the cause instead.
      void (async () => {
        for (const pid of s.participantIds) {
          await db.mcpServer
            .update({ where: { id: pid }, data: { status: "failed", lastError: `Supervised browser keeps crashing — see ${logPath(s.slug)}` } })
            .catch(() => undefined);
        }
      })();
      return;
    }
    console.log(`[browser-daemon] ${s.slug} exited (${code}) — reconcile will restart it on next poll.`);
  });
  // Confirm health: only mark the policy applied once OUR child survives.
  setTimeout(() => {
    void (async () => {
      if (s.stopped || s.child !== child || child.exitCode !== null || s.startToken !== startToken) return;
      const free = await isPortFree(port);
      if (!free) {
        // appliedPolicyVersion is per-row: set each participant to its own
        // policy version so every row's Applying badge clears.
        for (const pid of s.participantIds) {
          const want = s.policyVersions[pid];
          if (want === undefined) continue;
          await db.mcpServer
            .update({ where: { id: pid }, data: { appliedPolicyVersion: want, status: "ok", lastError: null } })
            .catch(() => undefined);
        }
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

  // Rows the daemon cannot supervise fail individually with an actionable
  // message; everything else is grouped by browser target below.
  const supervisable = servers.filter((s) => {
    if (s.browserMode === "cdp" && !s.cdpEndpoint) {
      void db.mcpServer
        .update({ where: { id: s.id }, data: { status: "failed", lastError: "CDP mode needs a cdpEndpoint." } })
        .catch(() => undefined);
      return false;
    }
    if (portFromUrl(s.url) === null && s.browserMode !== "cdp") {
      void db.mcpServer
        .update({ where: { id: s.id }, data: { status: "failed", lastError: `Only loopback URLs are supervised (got ${s.url}).` } })
        .catch(() => undefined);
      return false;
    }
    return true;
  });
  const rules = await db.mcpOriginRule.findMany({
    where: { mcpServerId: { in: supervisable.map((s) => s.id) }, enabled: true },
  });
  const rulesByServer = new Map<string, { pattern: string; kind: string }[]>();
  for (const r of rules) {
    const list = rulesByServer.get(r.mcpServerId) ?? [];
    list.push({ pattern: r.pattern, kind: r.kind });
    rulesByServer.set(r.mcpServerId, list);
  }

  const seenKeys = new Set<string>();
  // One MCP listener per port: groups colliding on a port are refused except
  // the oldest (by owner createdAt). A CDP row and an extension row cannot
  // share :8931 — give the second its own port. Refuse with a message, never
  // crash-loop into EADDRINUSE.
  const groups = groupServers(supervisable);
  const byPort = new Map<number, typeof groups>();
  for (const g of groups) {
    const list = byPort.get(g.port) ?? [];
    list.push(g);
    byPort.set(g.port, list);
  }
  const collidingKeys = new Set<string>();
  for (const [port, list] of byPort) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.owner.createdAt.getTime() - b.owner.createdAt.getTime());
    for (const loser of list.slice(1)) {
      collidingKeys.add(loser.key);
      for (const m of loser.members) {
        await db.mcpServer
          .update({ where: { id: m.id }, data: { status: "failed", lastError: `Shares MCP port :${port} with ${list[0]!.owner.name} — give this row its own port.` } })
          .catch(() => undefined);
      }
    }
  }
  for (const group of groups) {
    if (collidingKeys.has(group.key)) continue;
    // Dedication invariant, runtime half (the write-time guard in
    // add/updateMcpServer is the other half): one row per target. A shared
    // group refuses loudly instead of sharing a child — post-lock-retirement
    // there is no runtime arbitration left, so sharing must fail closed
    // here, never silently. Covers rows that predate the guard, direct DB
    // edits, and restored backups.
    if (group.members.length > 1) {
      const sig = group.members.map((m) => m.id).sort().join(",");
      if (refusedSignatures.get(group.key) !== sig) {
        refusedSignatures.set(group.key, sig);
        const names = group.members.map((m) => m.name).join(", ");
        const target = group.key.replace(/:(managed|ext)$/, "");
        const msg = `Target ${target} is shared by ${group.members.length} rows (${names}) — dedication requires one row per target; point the others at free ports.`;
        console.error(`[browser-daemon] REFUSING ${group.key}: ${msg}`);
        for (const m of group.members) {
          await db.mcpServer
            .update({ where: { id: m.id }, data: { status: "failed", lastError: msg } })
            .catch(() => undefined);
        }
      }
      // Fail closed fully: no child serves a violated target. The entry is
      // left in place (childless) so removing the extra row resumes cleanly
      // through the normal settled-restart path below.
      const doomed = supervised.get(group.key);
      if (doomed) {
        seenKeys.add(group.key);
        await stopChild(doomed);
      }
      continue;
    }
    refusedSignatures.delete(group.key);
    for (const m of group.members) seen.add(m.id);
    seenKeys.add(group.key);
    const hash = policyHashFor(group.members);
    const now = Date.now();
    const existing = supervised.get(group.key);
    if (existing && existing.policyHash !== hash) {
      // Policy churn: record and settle. The restart fires once quiet —
      // rapid re-saves coalesce into ONE restart instead of arming one per
      // save (and each arm used to clear gaveUp: the batch-of-5 trigger).
      existing.policyVersions = Object.fromEntries(group.members.map((m) => [m.id, m.policyVersion]));
      existing.policyHash = hash;
      existing.participantIds = group.members.map((m) => m.id);
      existing.lastBumpAt = now;
      existing.restartPending = true;
      console.log(`[browser-daemon] policy change on ${group.key} — settling ${SETTLE_MS / 1000}s before restart (sessions will reset; logins in dedicated profiles persist).`);
      continue;
    }
    let policyRestart = false;
    if (existing) {
      if (existing.child) continue;
      if (existing.restartPending) {
        if (now - existing.lastBumpAt < SETTLE_MS) continue; // still churning
        existing.restartPending = false;
        existing.gaveUp = false; // settled operator intent = new chance
        policyRestart = true;
      } else if (existing.gaveUp) {
        continue;
      }
      // Else: crash recovery or busy-port retry — reconcile owns the start
      // (exit handler only records), always behind waitForPortFree below.
    }

    if (existing && policyRestart) {
      console.log(`[browser-daemon] policy change on ${group.key} settled — restarting (sessions will reset; logins in dedicated profiles persist).`);
    }
    if (existing) {
      await stopChild(existing);
      existing.stopped = false;
    }
    const built = await buildGroupArgs(group.owner, group.members, rulesByServer);
    if ("error" in built) {
      console.error(`[browser-daemon] ${group.key}: ${built.error}`);
      for (const m of group.members) {
        await db.mcpServer
          .update({ where: { id: m.id }, data: { status: "failed", lastError: built.error } })
          .catch(() => undefined);
      }
      continue;
    }
    const entry: Supervised = existing ?? {
      groupKey: group.key,
      port: group.port,
      ownerId: group.owner.id,
      participantIds: [],
      policyVersions: {},
      policyHash: "",
      slug: group.owner.name,
      child: null,
      restarts: [],
      stopped: false,
      gaveUp: false,
      startToken: 0,
      lastBumpAt: 0,
      restartPending: false,
    };
    entry.ownerId = group.owner.id;
    entry.participantIds = group.members.map((m) => m.id);
    entry.policyVersions = Object.fromEntries(group.members.map((m) => [m.id, m.policyVersion]));
    entry.policyHash = hash;
    entry.port = group.port;
    entry.slug = group.owner.name;
    supervised.set(group.key, entry);
    let free = await waitForPortFree(group.port, PORT_WAIT_MS);
    if (!free) {
      // A stale MCP orphan from a crashed daemon wedges the port forever —
      // reap it once (Playwright MCP processes only, never anything else).
      const holder = portHolder(group.port);
      if (holder && reapMcpOrphan(holder)) free = await waitForPortFree(group.port, PORT_WAIT_MS);
    }
    if (!free) {
      console.error(`[browser-daemon] ${group.key}: port ${group.port} still busy — will retry on next poll.`);
      continue;
    }
    startChild(entry, mcpCliEntry(), built.args, built.spec, group.port);
  }

  for (const [key, s] of supervised) {
    if (!seenKeys.has(key)) {
      console.log(`[browser-daemon] ${s.slug} no longer supervised — stopping.`);
      await stopChild(s);
      supervised.delete(key);
    }
  }
}

async function main(): Promise<void> {
  teeDaemonOutput();
  const lock = acquireDaemonLock();
  if (!lock.ok) {
    console.error(
      `[browser-daemon] Another browser-mcp-daemon is already running (pid ${lock.holder.pid}, ` +
      `repo ${lock.holder.repoPath}, started ${lock.holder.startedAt}). One daemon per machine — it ` +
      `supervises every project's rows. Stop the other one first (or delete ${daemonLockPath()} if that process is gone).`,
    );
    process.exit(1);
  }
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
      releaseDaemonLock();
      for (const s of supervised.values()) {
        await stopChild(s);
      }
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
