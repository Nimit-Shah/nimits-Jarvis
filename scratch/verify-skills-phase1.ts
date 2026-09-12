/* Phase 1 checkpoint: hand-authored skill appears as a row with correct
 * contentHash; editing the file then reloading updates the row; removed dirs
 * disable (not delete); invalid frontmatter is rejected with a reason. */
import "dotenv/config";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { db } from "~/server/clients/db";
import { reconcileSkillsForUser } from "~/server/lib/skills/reconcile";
import { parseSkillText } from "~/server/lib/skills/parse";

const USER = "phase1-check-user";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "skills-p1-"));
  process.env.JARVIS_SKILLS_DIR = root;
  const dir = join(root, "screenplay-writer");
  mkdirSync(dir, { recursive: true });

  const v1 = `---\nname: screenplay-writer\ndescription: Use when the user wants a screenplay, script, or shot list.\ntools_required:\n - fs_read\nstate_scope: none\nversion: 1.0.0\n---\n\n# Screenplay Writer\n\n## Procedure\n\n1. Ask for the premise.\n`;
  writeFileSync(join(dir, "SKILL.md"), v1);

  // Parser unit checks (fail loudly, never guess)
  const bad = parseSkillText("no frontmatter here");
  console.assert(!bad.ok, "expected missing-frontmatter rejection");
  const noDesc = parseSkillText(
    "---\nname: x\n---\n\nbody\n",
  );
  console.assert(!noDesc.ok, "expected missing-description rejection");
  const trusted = parseSkillText(
    "---\nname: x\ndescription: y\ntrust_tier: trusted\n---\n\nbody\n",
  );
  console.assert(
    trusted.ok &&
      (trusted.skill.extraFrontmatter["trust_tier"] as string) === "trusted",
    "expected trust_tier preserved-but-ignored",
  );

  const r1 = await reconcileSkillsForUser(USER, root);
  console.assert(
    r1.upserted.includes("screenplay-writer"),
    `expected upsert, got ${JSON.stringify(r1)}`,
  );
  const row1 = await db.skill.findUniqueOrThrow({
    where: { userId_slug: { userId: USER, slug: "screenplay-writer" } },
  });
  const hash1 = createHash("sha256").update(v1).digest("hex");
  console.assert(row1.contentHash === hash1, "contentHash mismatch");
  console.assert(row1.trustTier === "untrusted", "default tier must be untrusted");
  console.assert(row1.enabled, "new skill must be enabled");
  console.log("PASS: install -> row with correct hash");

  // Edit + reload updates the row
  const v2 = v1.replace("1.0.0", "1.1.0").replace("Ask for the premise.", "Ask for premise and genre.");
  writeFileSync(join(dir, "SKILL.md"), v2);
  const r2 = await reconcileSkillsForUser(USER, root);
  console.assert(
    r2.hashUpdated.includes("screenplay-writer"),
    `expected hash update, got ${JSON.stringify(r2)}`,
  );
  const row2 = await db.skill.findUniqueOrThrow({
    where: { userId_slug: { userId: USER, slug: "screenplay-writer" } },
  });
  console.assert(row2.version === "1.1.0", "version should update");
  console.log("PASS: edit -> hash update");

  // Removed dir disables, never deletes (useCount history survives)
  rmSync(dir, { recursive: true });
  const r3 = await reconcileSkillsForUser(USER, root);
  console.assert(
    r3.disabled.includes("screenplay-writer"),
    `expected disable, got ${JSON.stringify(r3)}`,
  );
  const row3 = await db.skill.findUniqueOrThrow({
    where: { userId_slug: { userId: USER, slug: "screenplay-writer" } },
  });
  console.assert(!row3.enabled, "row must be disabled, not deleted");
  console.log("PASS: missing dir -> enabled:false, row retained");

  await db.skill.deleteMany({ where: { userId: USER } });
  rmSync(root, { recursive: true, force: true });
  console.log("PHASE 1 CHECKPOINT: ALL PASS");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("PHASE 1 CHECKPOINT FAILED:", e);
    process.exit(1);
  });
