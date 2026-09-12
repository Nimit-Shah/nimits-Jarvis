/* Phase 8b (install_skill): name-walk discovery, shared finalize, trust
 * check, source validation, web-only gating. Hermetic — no network. */
import "dotenv/config";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "~/server/clients/db";
import {
  finalizeStagedSkill,
  findSkillSubdir,
  ImportError,
} from "~/server/lib/skills/import-pipeline";
import { checkCandidateTrust } from "~/server/lib/skills/trust-check";
import { createInstallSkillTool } from "~/server/api/routers/nimits-jarvis/agent/tools/install-skill";
import { installSkillSchema } from "~/server/api/routers/nimits-jarvis/agent/tools/install-skill.schema";
import { createCustomTools } from "~/server/api/routers/nimits-jarvis/agent/tools";

const USER = "phase8b-check-user";
let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
};

const skillMd = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`;

async function main() {
  // ── Name-walk fixture: nested containers, shallow shadows deep ──
  const repo = mkdtempSync(join(tmpdir(), "skills-repo-"));
  const deep = join(repo, "skills", "cat", "deep-skill");
  const shallow = join(repo, ".claude", "skills", "shallow-skill");
  mkdirSync(deep, { recursive: true });
  mkdirSync(shallow, { recursive: true });
  mkdirSync(join(repo, "skills", "shallow-skill"), { recursive: true });
  writeFileSync(join(deep, "SKILL.md"), skillMd("deep-skill", "Deep nested skill."));
  writeFileSync(join(shallow, "SKILL.md"), skillMd("shallow-skill", "Dot-container skill."));
  writeFileSync(join(repo, "skills", "shallow-skill", "SKILL.md"), skillMd("shallow-skill", "Shallow wins."));

  const foundDeep = await findSkillSubdir(repo, { name: "deep-skill" });
  check("walk: 3-level nested found", foundDeep === deep);
  const foundShallow = await findSkillSubdir(repo, { name: "shallow-skill" });
  check("walk: shallow shadows deep/dot", foundShallow === join(repo, "skills", "shallow-skill"));
  let notFound = false;
  try {
    await findSkillSubdir(repo, { name: "nope" });
  } catch (e) {
    notFound = e instanceof ImportError;
  }
  check("walk: unknown name loud ImportError", notFound);

  // ── Shared finalize ──
  const staged = mkdtempSync(join(tmpdir(), "skills-stage-"));
  writeFileSync(join(staged, "SKILL.md"), skillMd("w8-skill", "Use when testing phase eight."));
  const fin = await finalizeStagedSkill({
    userId: USER,
    stagedDir: staged,
    sourceRepo: "https://github.com/o/r",
    sourceRef: "abc123",
    discoverySource: "auto",
    discoveryQuery: "test query",
  });
  check("finalize: slug + untrusted", fin.slug === "w8-skill" && fin.trustTier === "untrusted");
  const row = await db.skill.findUniqueOrThrow({
    where: { userId_slug: { userId: USER, slug: "w8-skill" } },
  });
  check("finalize: discovery audit trail", row.discoverySource === "auto" && row.discoveryQuery === "test query");
  check("finalize: sourceRef kept", row.sourceRef === "abc123");
  let conflict = false;
  try {
    await finalizeStagedSkill({ userId: USER, stagedDir: staged, sourceRepo: "x" });
  } catch (e) {
    conflict = e instanceof ImportError && e.code === "CONFLICT";
  }
  check("finalize: collision CONFLICT", conflict);
  let slugMismatch = false;
  try {
    await finalizeStagedSkill({ userId: USER, stagedDir: staged, sourceRepo: "x", slugOverride: "other" });
  } catch (e) {
    slugMismatch = e instanceof ImportError;
  }
  check("finalize: slug override mismatch rejected", slugMismatch);

  // ── Trust check (mocked API) ──
  const realFetch = globalThis.fetch;
  const mockAudits = (audits: unknown) => {
    (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
      ok: true,
      json: async () => ({ audits }),
    });
  };
  process.env.VERCEL_OIDC_TOKEN = "test-token";
  mockAudits([{ provider: "Snyk", status: "fail", summary: "evil", riskLevel: "HIGH" }]);
  const disq = await checkCandidateTrust({ slug: "s", source: "o/r@s", installs: 99999 });
  check("trust: fail audit disqualifies", disq.verdict === "disqualify");
  mockAudits([{ provider: "Snyk", status: "warn", summary: "review it" }]);
  const warn = await checkCandidateTrust({ slug: "s", source: "o/r@s", installs: 99999 });
  check("trust: warn audit warns", warn.verdict === "warn");
  mockAudits([]);
  const low = await checkCandidateTrust({ slug: "s", source: "o/r@s", installs: 50 });
  check("trust: low installs warns", low.verdict === "warn" && low.reasons.some((r) => r.includes("Low install count")));
  (globalThis as unknown as { fetch: unknown }).fetch = async () => ({ ok: false, status: 404 });
  const unaudited = await checkCandidateTrust({ slug: "s", source: "o/r@s", installs: 5000 });
  check("trust: unaudited notes, still pass", unaudited.verdict === "pass");
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  delete process.env.VERCEL_OIDC_TOKEN;

  // ── install_skill tool ──
  check("schema: rejects shell metachars", !installSkillSchema.safeParse({ source: "a/b; rm -rf /" }).success);
  check("schema: rejects spaces", !installSkillSchema.safeParse({ source: "a/b @s" }).success);
  check("schema: accepts owner/repo@skill", installSkillSchema.safeParse({ source: "o/r@s" }).success);

  const tool = createInstallSkillTool({
    userId: USER, instanceId: "i", chatId: "c", toolNamesRef: { current: [] },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exec = (args: any) => (tool.execute as any)(args, { toolCallId: "t" });
  process.env.VERCEL_OIDC_TOKEN = "test-token";
  (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
    ok: true,
    json: async () => ({ audits: [{ provider: "X", status: "fail", summary: "bad", riskLevel: "CRITICAL" }] }),
  });
  const refused = await exec({ source: "o/r@s" });
  check("install: disqualifying audit blocks pre-clone", refused?.error?.code === "SKILL_UNTRUSTED_SOURCE");
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  delete process.env.VERCEL_OIDC_TOKEN;

  // ── Web-only gating ──
  const ref = { current: [] as string[] };
  const web = createCustomTools("i", "c", "UTC", undefined, {
    userId: USER, instanceId: "i", chatId: "c", toolNamesRef: ref,
    loadedSlugs: new Set(), hasIndex: false, source: "web",
  });
  check("gate: install_skill on web", "install_skill" in web);
  const cron = createCustomTools("i", "c", "UTC", undefined, {
    userId: USER, instanceId: "i", chatId: "c", toolNamesRef: ref,
    loadedSlugs: new Set(), hasIndex: false, source: "cron",
  });
  check("gate: no install_skill on cron", !("install_skill" in cron));

  await db.skill.deleteMany({ where: { userId: USER } });
  rmSync(repo, { recursive: true, force: true });
  rmSync(staged, { recursive: true, force: true });
  console.log(failures === 0 ? "PHASE 8B CHECKPOINT: ALL PASS" : `PHASE 8B CHECKPOINT: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("PHASE 8B CHECKPOINT FAILED:", e);
  process.exit(1);
});
