/* Phase 3 checkpoint: Tier-1 index in the static prompt (sorted, stable,
 * untrusted absent, verified marked pin-only), load_skill E2E (trusted loads
 * verbatim, others refused loudly), registration gated on non-empty index. */
import "dotenv/config";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "~/server/clients/db";
import { buildSystemPrompt } from "~/server/api/routers/nimits-jarvis/agent/system-prompt";
import { createCustomTools } from "~/server/api/routers/nimits-jarvis/agent/tools";
import { createLoadSkillTool } from "~/server/api/routers/nimits-jarvis/agent/tools/load-skill";

const USER = "phase3-check-user";
const OTHER = "phase3-other-user";
let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
};

const basePrompt = {
  soulPrompt: null,
  identityPrompt: null,
  userPrompt: null,
};

async function main() {
  const root = mkdtempSync(join(tmpdir(), "skills-p3-"));
  process.env.JARVIS_SKILLS_DIR = root;

  // Trusted skill with a real email + references file
  const body = `---\nname: morning\ndescription: Use when the user wants the daily briefing from calendar, mail and markets.\ntools_required:\n - fs_read\n - MISSING_TOOL\nstate_scope: none\nversion: 2.0.0\n---\n\n# Morning\n\nSend the summary to nimit@example.com when done.\n`;
  const dir = join(root, "morning");
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
  writeFileSync(join(dir, "references", "format.md"), "# format\n");

  await db.skill.create({
    data: {
      userId: USER, slug: "morning", displayName: "morning",
      description: "Use when the user wants the daily briefing from calendar, mail and markets.",
      origin: "authored", dirPath: dir, contentHash: "x", version: "2.0.0",
      trustTier: "trusted", toolsRequired: ["fs_read", "MISSING_TOOL"], stateScope: "none",
    },
  });
  await db.skill.create({
    data: {
      userId: USER, slug: "figma-design-to-code", displayName: "figma",
      description: "Convert a Figma node into production React components.",
      origin: "imported", dirPath: join(root, "figma-design-to-code"),
      contentHash: "y", trustTier: "verified", toolsRequired: [], stateScope: "none",
    },
  });
  await db.skill.create({
    data: {
      userId: USER, slug: "evil", displayName: "evil", description: "Evil.",
      origin: "imported", dirPath: join(root, "evil"), contentHash: "z",
      trustTier: "untrusted", toolsRequired: [], stateScope: "none",
    },
  });
  await db.skill.create({
    data: {
      userId: OTHER, slug: "theirs", displayName: "theirs", description: "Theirs.",
      origin: "authored", dirPath: join(root, "theirs"), contentHash: "w",
      trustTier: "trusted", toolsRequired: [], stateScope: "none",
    },
  });

  // ── Index rendering ──
  const rows = await db.skill.findMany({
    where: { userId: USER, enabled: true, trustTier: { in: ["trusted", "verified"] } },
    select: { slug: true, description: true, trustTier: true },
    orderBy: { slug: "asc" },
  });
  const skills = rows.map((r) => ({
    slug: r.slug, description: r.description, pinOnly: r.trustTier !== "trusted",
  }));
  const p1 = buildSystemPrompt({ ...basePrompt, availableSkills: skills });
  const p2 = buildSystemPrompt({ ...basePrompt, availableSkills: skills });
  check("index: byte-identical across builds", p1 === p2);
  check("index: sorted by slug", p1.indexOf("figma-design-to-code") < p1.indexOf("- morning:"));
  check("index: verified marked pin-only", p1.includes("- figma-design-to-code (pin to use):"));
  check("index: untrusted absent", !p1.includes("evil"));
  check("index: static region (before volatile — no mode lines)", !p1.includes("FILE ACCESS"));
  const p0 = buildSystemPrompt({ ...basePrompt });
  check("index: omitted when empty", !p0.includes("AVAILABLE SKILLS"));

  // ── Registration gating ──
  const ref = { current: [] as string[] };
  const withIndex = createCustomTools("i", "c", "UTC", undefined, {
    userId: USER, instanceId: "i", chatId: "c", toolNamesRef: ref,
    loadedSlugs: new Set(), hasIndex: true,
  });
  check("tool: load_skill registered with index", "load_skill" in withIndex);
  const without = createCustomTools("i", "c", "UTC");
  check("tool: load_skill absent without index", !("load_skill" in without));

  // ── Execute ──
  ref.current = ["fs_read", "memory_save", "load_skill"];
  const tool = createLoadSkillTool({
    userId: USER, instanceId: "i", chatId: "c", toolNamesRef: ref,
    loadedSlugs: new Set(),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exec = (args: any) => (tool.execute as any)(args, { toolCallId: "t1" });
  const loaded = await exec({ slug: "morning" });
  check("load: instructions verbatim (real email, no tokens)", typeof loaded.instructions === "string" && loaded.instructions.includes("nimit@example.com") && !loaded.instructions.includes("trustclaw"));
  check("load: toolsAvailable/Missing split", loaded.toolsAvailable.includes("fs_read") && loaded.toolsMissing.includes("MISSING_TOOL"));
  check("load: references listed, contents not inlined", loaded.references.includes("format.md") && !loaded.instructions.includes("# format"));
  check("load: state null for none-scope", loaded.state === null);
  const used = await db.skill.findUniqueOrThrow({ where: { userId_slug: { userId: USER, slug: "morning" } } });
  check("load: useCount/lastUsedAt updated", used.useCount === 1 && used.lastUsedAt !== null);

  const verifiedRefusal = await exec({ slug: "figma-design-to-code" });
  check("load: verified refused (pin-only)", verifiedRefusal?.error?.code === "SKILL_PIN_REQUIRED");
  const untrustedRefusal = await exec({ slug: "evil" });
  check("load: untrusted refused", untrustedRefusal?.error?.code === "SKILL_PIN_REQUIRED");
  const missing = await exec({ slug: "nope" });
  check("load: unknown slug not found", missing?.error?.code === "SKILL_NOT_FOUND");
  const crossUser = await exec({ slug: "theirs" });
  check("load: other user's skill not found", crossUser?.error?.code === "SKILL_NOT_FOUND");

  // ── Wiring presence (setup.ts single merge point) ──
  const setupSrc = readFileSync(
    "src/server/api/routers/nimits-jarvis/agent/setup.ts", "utf-8",
  );
  check("wire: load_skill in piiStructuralTools", setupSrc.includes('"load_skill",'));
  check("wire: skills index queried pre-prompt", setupSrc.includes("skillIndexRows"));

  await db.skill.deleteMany({ where: { userId: { in: [USER, OTHER] } } });
  rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? "PHASE 3 CHECKPOINT: ALL PASS" : `PHASE 3 CHECKPOINT: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("PHASE 3 CHECKPOINT FAILED:", e);
  process.exit(1);
});
