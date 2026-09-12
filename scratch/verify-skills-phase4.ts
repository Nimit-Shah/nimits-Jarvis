/* Phase 4 checkpoint: pinning a verified skill loads it while load_skill on
 * the same slug is refused; ownership/instance/source gating; tool cap from
 * pins; pinned block format mirrors load_skill. */
import "dotenv/config";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "~/server/clients/db";
import { resolvePinnedSkills } from "~/server/lib/skills/pins";
import { formatPinnedSkillBlock } from "~/server/lib/skills/materialize";
import { applySkillToolCap } from "~/server/lib/skills/cap";
import { createLoadSkillTool } from "~/server/api/routers/nimits-jarvis/agent/tools/load-skill";
import type { ToolSet } from "ai";

const USER = "phase4-check-user";
const OTHER = "phase4-other-user";
let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
};

const skillMd = (name: string, desc: string, tools: string[], extraBody = "") =>
  `---\nname: ${name}\ndescription: ${desc}\ntools_required:\n${tools.map((t) => ` - ${t}`).join("\n")}\nstate_scope: none\n---\n\n# ${name}\n\nBody for ${name} to nimit@example.com.\n${extraBody}`;

async function main() {
  const root = mkdtempSync(join(tmpdir(), "skills-p4-"));
  process.env.JARVIS_SKILLS_DIR = root;
  const mk = (slug: string, content: string) => {
    const d = join(root, slug);
    mkdirSync(join(d, "references"), { recursive: true });
    writeFileSync(join(d, "SKILL.md"), content);
    writeFileSync(join(d, "references", "r.md"), "ref\n");
    return d;
  };

  const morningDir = mk("morning", skillMd("morning", "Daily briefing.", ["fs_read", "GMAIL_SEND_EMAIL"]));
  const figmaDir = mk("figma-design-to-code", skillMd("figma-design-to-code", "Figma to code.", ["fs_read"]));
  const evilDir = mk("evil", skillMd("evil", "Evil.", ["fs_read"]));
  const scopedDir = mk("scoped", skillMd("scoped", "Scoped.", ["fs_read"]));

  await db.skill.createMany({
    data: [
      { userId: USER, slug: "morning", displayName: "morning", description: "Daily briefing.", origin: "authored", dirPath: morningDir, contentHash: "a", trustTier: "trusted", toolsRequired: ["fs_read", "GMAIL_SEND_EMAIL"], stateScope: "none" },
      { userId: USER, slug: "figma-design-to-code", displayName: "figma", description: "Figma to code.", origin: "imported", dirPath: figmaDir, contentHash: "b", trustTier: "verified", toolsRequired: ["fs_read"], stateScope: "none" },
      { userId: USER, slug: "evil", displayName: "evil", description: "Evil.", origin: "imported", dirPath: evilDir, contentHash: "c", trustTier: "untrusted", toolsRequired: ["fs_read"], stateScope: "none" },
      { userId: USER, slug: "scoped", displayName: "scoped", description: "Scoped.", origin: "authored", dirPath: scopedDir, contentHash: "d", trustTier: "verified", toolsRequired: ["fs_read"], stateScope: "none", instanceId: "other-instance" },
      { userId: OTHER, slug: "morning", displayName: "theirs", description: "Theirs.", origin: "authored", dirPath: morningDir, contentHash: "e", trustTier: "trusted", toolsRequired: [], stateScope: "none" },
    ],
  });

  // ── The core Phase-4 assertion ──
  const tool = createLoadSkillTool({
    userId: USER, instanceId: "i", chatId: "c",
    toolNamesRef: { current: ["fs_read"] }, loadedSlugs: new Set(),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refused = await (tool.execute as any)({ slug: "figma-design-to-code" }, { toolCallId: "t" });
  check("pin-only: load_skill refuses verified slug", refused?.error?.code === "SKILL_PIN_REQUIRED");

  const { pins, loadedSlugs } = await resolvePinnedSkills({
    userId: USER, instanceId: "i", chatId: "c", source: "web",
    slugs: ["figma-design-to-code", "morning", "evil", "scoped", "nope"],
  });
  const slugs = pins.map((p) => p.slug);
  check("pin: verified loads via pin", slugs.includes("figma-design-to-code"));
  check("pin: trusted loads via pin", slugs.includes("morning"));
  check("pin: untrusted loads via pin", slugs.includes("evil"));
  check("pin: out-of-instance dropped", !slugs.includes("scoped"));
  check("pin: unknown dropped", !slugs.includes("nope"));
  check("pin: no cross-user leak", pins.find((p) => p.slug === "morning")?.displayName === "morning");
  check("pin: loadedSlugs unlock references", loadedSlugs.has("figma-design-to-code") && loadedSlugs.has("evil"));

  const cron = await resolvePinnedSkills({
    userId: USER, instanceId: "i", chatId: "c", source: "cron", slugs: ["morning"],
  });
  check("pin: cron source resolves no pins", cron.pins.length === 0);
  const tg = await resolvePinnedSkills({
    userId: USER, instanceId: "i", chatId: "c", source: "telegram", slugs: ["morning"],
  });
  check("pin: telegram source resolves no pins", tg.pins.length === 0);

  // ── Cap from pins: verified pin caps, untrusted pin strips destructive ──
  const all = Object.fromEntries(
    ["fs_read", "fs_write", "GMAIL_SEND_EMAIL", "memory_save", "schedule", "load_skill"].map((n) => [n, { description: n }]),
  ) as unknown as ToolSet;
  const cappedV = applySkillToolCap(all, pins.filter((p) => p.slug === "figma-design-to-code").map((p) => ({ trustTier: p.trustTier, toolsRequired: p.toolsRequired })));
  check("cap: verified pin keeps declared fs_read", "fs_read" in cappedV);
  check("cap: verified pin drops undeclared gmail", !("GMAIL_SEND_EMAIL" in cappedV));
  const cappedU = applySkillToolCap(all, pins.filter((p) => p.slug === "evil").map((p) => ({ trustTier: p.trustTier, toolsRequired: p.toolsRequired })));
  check("cap: untrusted pin read-only (no fs_write)", !("fs_write" in cappedU) && "fs_read" in cappedU);

  // ── Block format mirrors load_skill ──
  const morning = pins.find((p) => p.slug === "morning")!;
  const block = formatPinnedSkillBlock({
    slug: morning.slug, displayName: morning.displayName,
    instructions: morning.instructions!, stateScope: "none", toolsMissing: ["GMAIL_SEND_EMAIL"],
    references: morning.references, state: morning.state,
  });
  check("block: instructions verbatim (real email)", block.includes("nimit@example.com"));
  check("block: toolsMissing loud", block.includes("GMAIL_SEND_EMAIL"));
  check("block: references named", block.includes("r.md"));
  check("block: Using line present", block.includes('Start your reply with "Using morning."'));

  // ── Wiring presence ──
  const { readFileSync } = await import("node:fs");
  const setupSrc = readFileSync("src/server/api/routers/nimits-jarvis/agent/setup.ts", "utf-8");
  check("wire: cappedTools wrapped (not allTools)", setupSrc.includes("wrapToolExecutors(\n    cappedTools,"));
  check("wire: pinned block appended post-shield", setupSrc.includes("Pinned skills bypass the tool path"));
  const routeSrc = readFileSync("src/app/api/chat/route.ts", "utf-8");
  check("wire: route accepts + forwards pinnedSkills", routeSrc.includes("pinnedSkills: body.data.pinnedSkills"));

  await db.skill.deleteMany({ where: { userId: { in: [USER, OTHER] } } });
  rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? "PHASE 4 CHECKPOINT: ALL PASS" : `PHASE 4 CHECKPOINT: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("PHASE 4 CHECKPOINT FAILED:", e);
  process.exit(1);
});
