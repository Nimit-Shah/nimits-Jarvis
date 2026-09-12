import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { load as yamlLoad } from "js-yaml";
import { skillFrontmatterSchema } from "./parse.schema";

export interface ParsedSkill {
  slug: string;
  displayName: string;
  description: string;
  toolsRequired: string[];
  stateScope: string;
  version?: string;
  /** Frontmatter keys we do not act on (incl. trust_tier) — kept for scan. */
  extraFrontmatter: Record<string, unknown>;
  /** Body with frontmatter stripped — the load_skill instruction payload. */
  instructions: string;
  /** Full SKILL.md bytes — contentHash source and scan input. */
  raw: string;
  contentHash: string;
}

export type ParseSkillResult =
  | { ok: true; skill: ParsedSkill }
  | { ok: false; reason: string };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Parse raw SKILL.md text. Fails loudly — never guesses. */
export function parseSkillText(raw: string): ParseSkillResult {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return { ok: false, reason: "Missing YAML frontmatter (--- ... ---)" };
  }
  let frontmatter: unknown;
  try {
    frontmatter = yamlLoad(match[1] ?? "");
  } catch (err) {
    return {
      ok: false,
      reason: `Frontmatter is not valid YAML: ${(err as Error).message}`,
    };
  }
  if (typeof frontmatter !== "object" || frontmatter === null) {
    return { ok: false, reason: "Frontmatter must be a YAML mapping" };
  }
  const rawMap = frontmatter as Record<string, unknown>;
  // trust_tier is stripped before schema parse and never trusted — its
  // presence is preserved in extraFrontmatter as a scan finding.
  const { trust_tier: _trustTier, ...rest } = rawMap;
  void _trustTier;
  const parsed = skillFrontmatterSchema.safeParse(rest);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Invalid frontmatter: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const fm = parsed.data;
  const known = new Set([
    "name",
    "description",
    "tools_required",
    "state_scope",
    "version",
  ]);
  const extraFrontmatter: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawMap)) {
    if (!known.has(k)) extraFrontmatter[k] = v;
  }
  const instructions = (match[2] ?? "").trim();
  if (!instructions) {
    return { ok: false, reason: "SKILL.md body is empty" };
  }
  return {
    ok: true,
    skill: {
      slug: fm.name,
      displayName: fm.name,
      description: fm.description,
      toolsRequired: fm.tools_required,
      stateScope: fm.state_scope,
      version: fm.version,
      extraFrontmatter,
      instructions,
      contentHash: sha256Hex(raw),
      raw,
    },
  };
}

/** Read + parse SKILL.md at an absolute path. */
export async function parseSkillFile(skillMdPath: string): Promise<ParseSkillResult> {
  let raw: string;
  try {
    raw = await readFile(skillMdPath, "utf-8");
  } catch (err) {
    return {
      ok: false,
      reason: `Cannot read SKILL.md: ${(err as NodeJS.ErrnoException).code ?? String(err)}`,
    };
  }
  return parseSkillText(raw);
}
