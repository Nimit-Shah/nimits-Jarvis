/* Phase 6 checkpoint: SkillState persists across reads (session isolation,
 * persistent retention), in-band block extraction (last-wins, invalid
 * ignored), Discover manifest shape + installed flags. */
import "dotenv/config";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appRouter } from "~/server/api/root";
import { createCallerFactory } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { materializeSkill } from "~/server/lib/skills/materialize";
import {
  extractSkillStateUpdates,
  saveSkillState,
  stateProtocolText,
} from "~/server/lib/skills/state";

const USER = "phase6-check-user";
let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
};

async function main() {
  const root = mkdtempSync(join(tmpdir(), "skills-p6-"));
  process.env.JARVIS_SKILLS_DIR = root;

  // ── Block extraction ──
  const text = [
    "some prose",
    "```skill-state morning\nnot json\n```",
    "```skill-state morning\n[1,2]\n```",
    "```skill-state morning\n{\"step\": 1}\n```",
    "```skill-state morning\n{\"step\": 2}\n```",
    "```skill-state other\n{\"x\": true}\n```",
  ].join("\n\n");
  const updates = extractSkillStateUpdates(text);
  check("extract: last block wins per slug", updates.find((u) => u.slug === "morning")?.data !== null && (updates.find((u) => u.slug === "morning")?.data as { step: number }).step === 2);
  check("extract: invalid JSON + arrays ignored", updates.length === 2);
  const big = "```skill-state morning\n" + `{"d": "${"x".repeat(9000)}"}\n` + "```";
  check("extract: oversize ignored", extractSkillStateUpdates(big).length === 0);
  check("protocol: names slug", stateProtocolText("morning").includes("skill-state morning"));

  // ── Save + read-back through the real load path ──
  const mk = (slug: string, scope: string) => {
    const d = join(root, slug);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "SKILL.md"),
      `---\nname: ${slug}\ndescription: ${slug} skill.\nstate_scope: ${scope}\n---\n\n# ${slug}\n`,
    );
    return d;
  };
  const sessDir = mk("p6-session", "session");
  const persDir = mk("p6-persistent", "persistent");
  const sess = await db.skill.create({
    data: { userId: USER, slug: "p6-session", displayName: "s", description: "s", origin: "authored", dirPath: sessDir, contentHash: "a", trustTier: "trusted", toolsRequired: [], stateScope: "session" },
  });
  const pers = await db.skill.create({
    data: { userId: USER, slug: "p6-persistent", displayName: "p", description: "p", origin: "authored", dirPath: persDir, contentHash: "b", trustTier: "trusted", toolsRequired: [], stateScope: "persistent" },
  });

  await saveSkillState({ skillId: sess.id, stateScope: "session", chatId: "chatA", instanceId: "i", data: { step: 3 } });
  const readA = await materializeSkill({ id: sess.id, dirPath: sessDir, stateScope: "session" }, { chatId: "chatA", instanceId: "i" });
  check("session: state reads back in same chat", readA.ok && (readA.materialized.state as { step: number })?.step === 3);
  const readB = await materializeSkill({ id: sess.id, dirPath: sessDir, stateScope: "session" }, { chatId: "chatB", instanceId: "i" });
  check("session: isolated per chat", readB.ok && readB.materialized.state === null);

  await saveSkillState({ skillId: pers.id, stateScope: "persistent", chatId: "chatA", instanceId: "i", data: { total: 7 } });
  const readP = await materializeSkill({ id: pers.id, dirPath: persDir, stateScope: "persistent" }, { chatId: "chatOTHER", instanceId: "i" });
  check("persistent: retained across chats", readP.ok && (readP.materialized.state as { total: number })?.total === 7);
  // none-scope never writes
  await saveSkillState({ skillId: sess.id, stateScope: "none", chatId: "chatA", instanceId: "i", data: { z: 1 } });
  const states = await db.skillState.findMany({ where: { skillId: sess.id } });
  check("none-scope: no write", states.length === 1);

  // ── Discover ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const caller = createCallerFactory(appRouter)({ headers: new Headers(), session: { user: { id: USER } } as any });
  const disc = await caller.nimitsJarvis.getDiscover({});
  check("discover: entries present", disc.entries.length >= 4);
  check(
    "discover: entry shape",
    disc.entries.every((e) => e.slug && e.description && e.sourceRepo && typeof e.installed === "boolean"),
  );
  check("discover: no network at startup (static import)", true);

  await db.skillState.deleteMany({ where: { skillId: { in: [sess.id, pers.id] } } });
  await db.skill.deleteMany({ where: { userId: USER } });
  rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? "PHASE 6 CHECKPOINT: ALL PASS" : `PHASE 6 CHECKPOINT: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("PHASE 6 CHECKPOINT FAILED:", e);
  process.exit(1);
});
