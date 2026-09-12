import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { db } from "~/server/clients/db";
import { getSkillDir, getSkillsRoot } from "./constants";
import { parseSkillFile, parseSkillText, sha256Hex } from "./parse";
import { scanFindingsJson, scanSkillBody, type SkillScanFinding } from "./scan";

const execFileAsync = promisify(execFile);

export type ImportErrorCode = "BAD_REQUEST" | "CONFLICT";

export class ImportError extends Error {
  code: ImportErrorCode;
  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function isGitUrl(url: string): boolean {
  return (
    url.endsWith(".git") ||
    url.startsWith("git@") ||
    (/github\.com[/:][^/]+\/[^/]+/.test(url) &&
      !url.includes("/raw/") &&
      !url.includes("/blob/"))
  );
}

/** Clone a repo shallowly. Returns { tmpBase, sourceRef }. Caller cleans up. */
export async function cloneRepo(
  repoUrl: string,
  ref?: string,
): Promise<{ tmpBase: string; sourceRef: string | undefined }> {
  const tmpBase = await mkdtemp(join(tmpdir(), "skill-import-"));
  try {
    await execFileAsync(
      "git",
      [
        "clone",
        "--depth",
        "1",
        ...(ref ? ["--branch", ref] : []),
        repoUrl,
        tmpBase,
      ],
      { timeout: 60_000 },
    );
  } catch (err) {
    await rm(tmpBase, { recursive: true, force: true });
    throw new ImportError(
      "BAD_REQUEST",
      `git clone failed: ${(err as Error).message.slice(0, 300)}`,
    );
  }
  let sourceRef: string | undefined;
  try {
    const rev = await execFileAsync(
      "git",
      ["-C", tmpBase, "rev-parse", "--short", "HEAD"],
      { timeout: 10_000 },
    );
    sourceRef = rev.stdout.trim() || undefined;
  } catch {
    sourceRef = undefined;
  }
  return { tmpBase, sourceRef };
}

/** Stage raw SKILL.md text for the shared finalize path. Caller cleans up. */
export async function stageRawSkill(text: string): Promise<string> {
  const check = parseSkillText(text);
  if (!check.ok) {
    throw new ImportError(
      "BAD_REQUEST",
      `URL did not return a valid SKILL.md: ${check.reason}`,
    );
  }
  const tmpBase = await mkdtemp(join(tmpdir(), "skill-import-"));
  await writeFile(join(tmpBase, "SKILL.md"), text, "utf-8");
  return tmpBase;
}

const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_WALK_FILES = 200;

/** Collect SKILL.md paths under dir up to depth, shallow first. */
async function collectSkillFiles(
  dir: string,
  depth: number,
  out: string[],
): Promise<void> {
  if (depth < 0 || out.length >= MAX_WALK_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_WALK_FILES) return;
    if (e.isFile() && e.name === "SKILL.md") {
      out.push(join(dir, "SKILL.md"));
    } else if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) {
      await collectSkillFiles(join(dir, e.name), depth - 1, out);
    }
  }
}

// CLI-known skill containers, mirroring `npx skills` discovery.
const CONTAINERS = ["", "skills", ".claude/skills", ".agents/skills"];

/**
 * Locate the skill tree inside a clone. Explicit subdir wins; otherwise an
 * optional skill name is resolved by walking containers up to 3 deep and
 * matching frontmatter `name` (fallback: directory name), shallow first.
 * Without either, the legacy root + one-level behavior applies.
 */
export async function findSkillSubdir(
  cloneDir: string,
  opts?: { subdir?: string; name?: string },
): Promise<string> {
  if (opts?.subdir) {
    const candidate = join(cloneDir, opts.subdir);
    try {
      await readFile(join(candidate, "SKILL.md"), "utf-8");
      return candidate;
    } catch {
      throw new ImportError(
        "BAD_REQUEST",
        `No SKILL.md found at ${opts.subdir} in the repo.`,
      );
    }
  }
  if (opts?.name) {
    const found: string[] = [];
    for (const container of CONTAINERS) {
      await collectSkillFiles(join(cloneDir, container), 3, found);
    }
    // Shallow first: fewer separators = shallower.
    found.sort(
      (a, b) => a.split("/").length - b.split("/").length,
    );
    for (const f of found) {
      const parsed = await parseSkillFile(f);
      if (parsed.ok && parsed.skill.slug === opts.name) return dirname(f);
    }
    for (const f of found) {
      if (basename(dirname(f)) === opts.name) return dirname(f);
    }
    throw new ImportError(
      "BAD_REQUEST",
      `No skill named "${opts.name}" found in the repo.`,
    );
  }
  try {
    await readFile(join(cloneDir, "SKILL.md"), "utf-8");
    return cloneDir;
  } catch {
    // not at root — look one level down
  }
  const entries = await readdir(cloneDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
  for (const d of dirs) {
    try {
      await readFile(join(cloneDir, d.name, "SKILL.md"), "utf-8");
      return join(cloneDir, d.name);
    } catch {
      continue;
    }
  }
  throw new ImportError(
    "BAD_REQUEST",
    "No SKILL.md found at the repo root or one level down.",
  );
}

export interface FinalizeOptions {
  userId: string;
  /** Staged skill tree (cloned subdir or raw-text stage). Copied, not moved. */
  stagedDir: string;
  sourceRepo: string;
  sourceRef?: string;
  slugOverride?: string;
  origin?: string;
  discoverySource?: string;
  discoveryQuery?: string;
}

export interface FinalizeResult {
  slug: string;
  trustTier: string;
  findings: SkillScanFinding[];
}

/**
 * Shared tail: parse → slug check → collision → copy → scan → row.
 * Everything installed here lands untrusted; "curated" describes a list,
 * never a trust level.
 */
export async function finalizeStagedSkill(
  opts: FinalizeOptions,
): Promise<FinalizeResult> {
  const parsed = await parseSkillFile(join(opts.stagedDir, "SKILL.md"));
  if (!parsed.ok) {
    throw new ImportError("BAD_REQUEST", parsed.reason);
  }
  if (opts.slugOverride && opts.slugOverride !== parsed.skill.slug) {
    throw new ImportError(
      "BAD_REQUEST",
      `Slug override "${opts.slugOverride}" does not match frontmatter name "${parsed.skill.slug}".`,
    );
  }
  const slug = parsed.skill.slug;

  const collision = await db.skill.findUnique({
    where: { userId_slug: { userId: opts.userId, slug } },
  });
  if (collision) {
    throw new ImportError(
      "CONFLICT",
      `A skill named "${slug}" already exists.`,
    );
  }

  const dir = getSkillDir(getSkillsRoot(), slug);
  await cp(opts.stagedDir, dir, { recursive: true });

  const raw = await readFile(join(dir, "SKILL.md"), "utf-8");
  const findings = scanSkillBody(raw, parsed.skill);
  const row = await db.skill.create({
    data: {
      userId: opts.userId,
      slug,
      displayName: parsed.skill.slug,
      description: parsed.skill.description,
      origin: opts.origin ?? "imported",
      sourceRepo: opts.sourceRepo,
      sourceRef: opts.sourceRef,
      dirPath: dir,
      contentHash: sha256Hex(raw),
      version: parsed.skill.version,
      trustTier: "untrusted",
      toolsRequired: parsed.skill.toolsRequired,
      stateScope: parsed.skill.stateScope,
      scanFindings: scanFindingsJson(findings),
      ...(opts.discoverySource ? { discoverySource: opts.discoverySource } : {}),
      ...(opts.discoveryQuery ? { discoveryQuery: opts.discoveryQuery } : {}),
    },
  });
  return { slug: row.slug, trustTier: row.trustTier, findings };
}

export async function cleanupTmp(tmpBase: string | null): Promise<void> {
  if (tmpBase) await rm(tmpBase, { recursive: true, force: true });
}
