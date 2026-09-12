import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RegistryCandidate {
  /** Skill slug, e.g. "find-skills". */
  slug: string;
  /** Install identifier, e.g. "vercel-labs/skills@find-skills". */
  source: string;
  description?: string;
  installs?: number;
  url?: string;
}

export interface CliSearchResult {
  ok: boolean;
  candidates: RegistryCandidate[];
  /** Present when !ok — CLI exit/timeout/unparseable. */
  error?: string;
}

export type CliRunner = (
  argv: string[],
  opts: { timeoutMs: number; maxBufferBytes: number },
) => Promise<{ stdout: string; stderr: string }>;

const FIND_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 65_536;
const MAX_CANDIDATES = 10;
const MAX_QUERY_CHARS = 200;

const ANSI_RE = /\x1b\[[0-9;]*m/g;
// Strict: owner/repo@skill + installs. Header lines, tips, and garbage never match.
const ENTRY_RE =
  /^([\w.-]+\/[\w.-]+)@([\w.-]+)\s+([\d.,]+)\s*(K|M)?\s*installs?\s*$/i;
const URL_LINE_RE = /^└\s*(\S+)\s*$/;
// owner/repo[@skill] — validated before any subprocess or fetch call.
export const REGISTRY_SOURCE_RE = /^[\w.-]+\/[\w.-]+(@[\w.-]+)?$/;
const OWNER_RE = /^[\w.-]+$/;

function parseInstallCount(num: string, suffix: string | undefined): number {
  const base = parseFloat(num.replace(/,/g, "")) || 0;
  if (suffix?.toUpperCase() === "M") return Math.round(base * 1_000_000);
  if (suffix?.toUpperCase() === "K") return Math.round(base * 1_000);
  return Math.round(base);
}

/**
 * Strict parser for `skills find` stdout. Anything not matching an entry
 * line is dropped — adversarial or future-format text can never become a
 * candidate. Exported for tests.
 */
export function parseCliSearchOutput(stdout: string): RegistryCandidate[] {
  const lines = stdout.replace(ANSI_RE, "").split("\n");
  const candidates: RegistryCandidate[] = [];
  for (let i = 0; i < lines.length && candidates.length < MAX_CANDIDATES; i++) {
    const m = ENTRY_RE.exec(lines[i]!.trim());
    if (!m) continue;
    const repo = m[1]!;
    const slug = m[2]!;
    const next = (lines[i + 1] ?? "").trim();
    const um = URL_LINE_RE.exec(next);
    candidates.push({
      slug,
      source: `${repo}@${slug}`,
      installs: parseInstallCount(m[3]!, m[4]),
      ...(um ? { url: um[1] } : {}),
    });
  }
  return candidates;
}

const defaultRunner: CliRunner = async (argv, opts) =>
  execFileAsync(
    "npx",
    argv,
    {
      timeout: opts.timeoutMs,
      maxBuffer: opts.maxBufferBytes,
      encoding: "utf8",
      // Closed stdin: `find <query>` must never block on an interactive
      // prompt. ExecFileOptions omits stdio in @types/node but the runtime
      // honors it (probed: default inherits stdin and hangs).
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DO_NOT_TRACK: "1",
        DISABLE_TELEMETRY: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
    } as unknown as Parameters<typeof execFileAsync>[2],
  ).then((r) => ({ stdout: r.stdout.toString(), stderr: r.stderr.toString() }));

/**
 * CLI-first registry search (read-only). Subcommand is a constant — the model
 * influences only the query/owner positional args, so `add`/`remove`/`update`
 * are unreachable by construction. Never throws; failures are data for the
 * API fallback, never exceptions.
 */
export async function searchSkillsCli(
  query: string,
  opts?: { owner?: string; runner?: CliRunner },
): Promise<CliSearchResult> {
  const q = query.trim();
  if (!q) return { ok: false, candidates: [], error: "Empty query." };
  if (q.length > MAX_QUERY_CHARS) {
    return { ok: false, candidates: [], error: "Query too long." };
  }
  if (opts?.owner !== undefined && !OWNER_RE.test(opts.owner)) {
    return { ok: false, candidates: [], error: "Invalid owner." };
  }
  const argv = [
    "--yes",
    "skills",
    "find",
    q,
    ...(opts?.owner ? ["--owner", opts.owner] : []),
  ];
  try {
    const { stdout } = await (opts?.runner ?? defaultRunner)(argv, {
      timeoutMs: FIND_TIMEOUT_MS,
      maxBufferBytes: MAX_BUFFER_BYTES,
    });
    return { ok: true, candidates: parseCliSearchOutput(stdout) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, candidates: [], error: msg.slice(0, 300) };
  }
}
