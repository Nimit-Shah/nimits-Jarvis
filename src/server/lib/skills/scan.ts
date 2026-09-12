import type { Prisma } from "~/generated/prisma/client";
import type { ParsedSkill } from "./parse";

export interface SkillScanFinding {
  rule: string;
  detail: string;
}

/** Normalize findings for Prisma Json columns. */
export function scanFindingsJson(
  findings: SkillScanFinding[],
): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(findings)) as Prisma.InputJsonValue;
}

/**
 * Install/update-time static scan (§5.3). Flags, shows, lets the operator
 * decide — never sanitizes, never auto-rejects. Findings are stored on the
 * Skill row so a skill promoted months later still shows what was found.
 */

const RUNTIME_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bPIIVault\b/, label: "PIIVault" },
  { re: /\bfsAccessMode\b/, label: "fsAccessMode" },
  { re: /"full"/, label: '"full"' },
  { re: /\bread_tool_result\b/, label: "read_tool_result" },
  { re: /\bwrapToolExecutors\b/, label: "wrapToolExecutors" },
  { re: /\bsudo\b/, label: "sudo" },
  { re: /--force\b/, label: "--force" },
];

const TOOL_TOKEN_RES: RegExp[] = [
  /\b(?:fs_[a-z]+|memory_[a-z]+|schedule|read_tool_result|load_skill)\b/g,
  /\bCOMPOSIO_[A-Z_]+\b/g,
  /\bmcp__[a-z0-9-]+__[a-z0-9_]+\b/g,
  // Composio/discovered slugs (GMAIL_SEND_EMAIL, NOTION_GET_PAGE, ...):
  // any ALL_CAPS_SNAKE token is tool-slug-shaped.
  /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/g,
];

const OVERRIDE_RES: RegExp[] = [
  /ignore previous/i,
  /you are now/i,
  /do not tell the user/i,
  /regardless of (your|these) instructions/i,
];

const BASE64_RE = /[A-Za-z0-9+/]{200,}={0,2}/g;
const URL_RE = /https?:\/\/[^\s)"'\]]+/g;
const MAX_LISTED = 5;

function listed(items: string[]): string {
  const shown = [...new Set(items)].slice(0, MAX_LISTED);
  const extra = new Set(items).size - shown.length;
  return shown.join(", ") + (extra > 0 ? ` (+${extra} more)` : "");
}

export function scanSkillBody(raw: string, skill: ParsedSkill): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const body = skill.instructions;

  for (const { re, label } of RUNTIME_PATTERNS) {
    if (re.test(body)) {
      findings.push({
        rule: "runtime-reference",
        detail: `Body references ${label} — runtime internals a skill must not depend on or invoke.`,
      });
    }
  }

  const declared = new Set(skill.toolsRequired);
  const mentioned = new Set<string>();
  for (const re of TOOL_TOKEN_RES) {
    re.lastIndex = 0;
    for (const m of body.matchAll(re)) mentioned.add(m[0]);
  }
  const undeclared = [...mentioned].filter((t) => !declared.has(t));
  if (undeclared.length > 0) {
    findings.push({
      rule: "undeclared-tool",
      detail: `Body mentions tools absent from tools_required: ${listed(undeclared)}. They will be unavailable at runtime.`,
    });
  }

  const urls = body.match(URL_RE) ?? [];
  if (urls.length > 0) {
    findings.push({ rule: "url", detail: `Body contains URLs: ${listed(urls)}.` });
  }
  const b64 = (body.match(BASE64_RE) ?? []).filter((b) => b.length > 200);
  if (b64.length > 0) {
    findings.push({
      rule: "base64-block",
      detail: `Body contains ${b64.length} base64-like block(s) over 200 chars — review for embedded payloads.`,
    });
  }

  for (const re of OVERRIDE_RES) {
    if (re.test(body)) {
      findings.push({
        rule: "instruction-override",
        detail: `Body contains instruction-shaped string aimed at the runtime (${re.source}).`,
      });
    }
  }

  if ("trust_tier" in skill.extraFrontmatter) {
    findings.push({
      rule: "trust-tier-declared",
      detail:
        "Frontmatter declares trust_tier — ignored. Tier is assigned by the installer; this skill installed as untrusted.",
    });
  }

  void raw;
  return findings;
}
