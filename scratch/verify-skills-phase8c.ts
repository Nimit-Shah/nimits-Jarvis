/* Phase 8c (consent): affirmative/decline matcher units + consent-gated
 * pinning (fresh fires, stale never fires, decline declines, cron skips). */
import "dotenv/config";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "~/server/clients/db";
import {
  isAffirmativeReply,
  isDeclineReply,
  resolveConsentedSkills,
} from "~/server/lib/skills/consent";

const USER = "phase8c-check-user";
let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
};

async function main() {
  // ── Matcher ──
  for (const t of ["yes", "Yes.", "go ahead", "use it", "install it", "sounds good", "please do"]) {
    if (!isAffirmativeReply(t)) check(`affirmative: ${t}`, false);
  }
  check("matcher: affirmatives", true);
  for (const t of ["", "maybe later", "yes, but first explain the risks in detail please", "find something else", "what does it do?"]) {
    if (isAffirmativeReply(t)) check(`not-affirmative: ${t}`, false);
  }
  check("matcher: silence/ambiguity/verbosity denied", true);
  check("matcher: decline detected", isDeclineReply("no, don't install that"));
  check("matcher: decline not affirmative", !isAffirmativeReply("no, don't install that"));

  // ── Consent flow (real rows) ──
  const root = mkdtempSync(join(tmpdir(), "skills-p8c-"));
  process.env.JARVIS_SKILLS_DIR = root;
  await db.user.create({ data: { id: USER, name: "P8C", email: "p8c@example.com" } });
  const inst = await db.composioClawInstance.create({ data: { userId: USER, name: "P8C" } });
  const chat = await db.chat.create({ data: { instanceId: inst.id, name: "P8C" } });
  const dir = join(root, "w8c-skill");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: w8c-skill\ndescription: Use when testing consent.\n---\n\n# S\n");
  const skill = await db.skill.create({
    data: { userId: USER, slug: "w8c-skill", displayName: "s", description: "d", origin: "imported", dirPath: dir, contentHash: "x", trustTier: "untrusted", toolsRequired: [], stateScope: "none" },
  });
  void skill;

  const base = { userId: USER, instanceId: inst.id, chatId: chat.id, source: "web" };

  // Fresh pending + affirmative next message → pins, marks confirmed
  await db.skillConsent.create({ data: { chatId: chat.id, slug: "w8c-skill", status: "pending" } });
  const r1 = await resolveConsentedSkills({ ...base, userMessage: "yes, use it" });
  check("consent: fresh affirmative pins", r1.pins.some((p) => p.slug === "w8c-skill"));
  const c1 = await db.skillConsent.findUniqueOrThrow({ where: { chatId_slug: { chatId: chat.id, slug: "w8c-skill" } } });
  check("consent: marked confirmed", c1.status === "confirmed");

  // Single-turn "find and use it" without prior pending → nothing pins
  const r2 = await resolveConsentedSkills({ ...base, userMessage: "find and use it" });
  check("consent: no pending, no pin", r2.pins.length === 0);

  // Stale pending (another exchange happened after install) → never fires
  await db.skillConsent.update({ where: { chatId_slug: { chatId: chat.id, slug: "w8c-skill" } }, data: { status: "pending" } });
  await db.message.create({
    data: { instanceId: inst.id, chatId: chat.id, role: "user", content: [{ type: "text", text: "what does it cost?" }], source: "web" },
  });
  await db.message.create({
    data: { instanceId: inst.id, chatId: chat.id, role: "assistant", content: [{ type: "text", text: "something else" }], source: "web" },
  });
  const r3 = await resolveConsentedSkills({ ...base, userMessage: "yes" });
  check("consent: stale pending never fires", r3.pins.length === 0);

  // Decline marks declined
  await db.$executeRaw`UPDATE composio_claw_skill_consent SET status = 'pending', "updatedAt" = NOW() WHERE "chatId" = ${chat.id}`;
  // Remove the stale-making assistant message so freshness passes, then decline
  await db.message.deleteMany({ where: { chatId: chat.id } });
  const r4 = await resolveConsentedSkills({ ...base, userMessage: "no, skip it" });
  const c4 = await db.skillConsent.findUniqueOrThrow({ where: { chatId_slug: { chatId: chat.id, slug: "w8c-skill" } } });
  check("consent: decline pins nothing, marks declined", r4.pins.length === 0 && c4.status === "declined");

  // Cron never consents
  await db.skillConsent.update({ where: { chatId_slug: { chatId: chat.id, slug: "w8c-skill" } }, data: { status: "pending" } });
  const r5 = await resolveConsentedSkills({ ...base, source: "cron", userMessage: "yes" });
  check("consent: cron skips", r5.pins.length === 0);

  // Disabled skill never pins via consent
  await db.skill.update({ where: { id: skill.id }, data: { enabled: false } });
  const r6 = await resolveConsentedSkills({ ...base, userMessage: "yes" });
  check("consent: disabled skill skipped", r6.pins.length === 0);

  await db.skillConsent.deleteMany({ where: { chatId: chat.id } });
  await db.skill.deleteMany({ where: { userId: USER } });
  await db.chat.deleteMany({ where: { instanceId: inst.id } });
  await db.composioClawInstance.deleteMany({ where: { userId: USER } });
  await db.user.deleteMany({ where: { id: USER } });
  rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? "PHASE 8C CHECKPOINT: ALL PASS" : `PHASE 8C CHECKPOINT: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("PHASE 8C CHECKPOINT FAILED:", e);
  process.exit(1);
});
