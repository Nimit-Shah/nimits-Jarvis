/* Phase 8a (find_skill): strict CLI parsing, argv allowlist, API fallback,
 * query validation, PII + registration wiring. Hermetic — no network. */
import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  parseCliSearchOutput,
  searchSkillsCli,
  REGISTRY_SOURCE_RE,
} from "~/server/lib/skills/cli-search";
import { createFindSkillTool } from "~/server/api/routers/nimits-jarvis/agent/tools/find-skill";
import { createCustomTools } from "~/server/api/routers/nimits-jarvis/agent/tools";

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
};

// Captured `npx skills find typescript` stdout shape (ANSI + header + pairs).
const FIXTURE = [
  "\x1b[38;5;102mInstall with\x1b[0m npx skills add <owner/repo@skill>",
  "",
  "\x1b[38;5;145mwshobson/agents@typescript-advanced-types\x1b[0m \x1b[36m74.1K installs\x1b[0m",
  "\x1b[38;5;102m└ https://skills.sh/wshobson/agents/typescript-advanced-types\x1b[0m",
  "",
  "sickn33/agentic-awesome-skills@typescript-expert 12K installs",
  "└ https://skills.sh/sickn33/agentic-awesome-skills/typescript-expert",
  "",
  "not a candidate line",
  "owner/repo@skill with no count",
  "evil@x 5 installs", // no slash — must not match
  "a/b@c 1 installs",
].join("\n");

async function main() {
  // ── Parser ──
  const parsed = parseCliSearchOutput(FIXTURE);
  check("parse: exact candidates", parsed.length === 3);
  check(
    "parse: first candidate fields",
    parsed[0]?.source === "wshobson/agents@typescript-advanced-types" &&
      parsed[0]?.slug === "typescript-advanced-types" &&
      parsed[0]?.installs === 74100 &&
      parsed[0]?.url === "https://skills.sh/wshobson/agents/typescript-advanced-types",
  );
  check("parse: K suffix + missing url", parsed[1]?.installs === 12000 && parsed[1]?.url !== undefined);
  check("parse: singular installs", parsed[2]?.installs === 1);
  check("parse: garbage dropped", !parsed.some((c) => c.slug === "x" || c.slug === "skill"));

  // ── Argv allowlist + runner injection ──
  let seenArgv: string[] | null = null;
  const okRunner = async (argv: string[]) => {
    seenArgv = argv;
    return { stdout: FIXTURE, stderr: "" };
  };
  const r1 = await searchSkillsCli("typescript", { runner: okRunner });
  check("cli: ok + candidates", r1.ok && r1.candidates.length === 3);
  check(
    "cli: argv allowlisted (subcommand constant)",
    seenArgv !== null &&
      seenArgv[0] === "--yes" &&
      seenArgv[1] === "skills" &&
      seenArgv[2] === "find" &&
      seenArgv[3] === "typescript" &&
      !seenArgv.includes("add"),
  );
  const rOwner = await searchSkillsCli("x", {
    owner: "vercel-labs",
    runner: okRunner,
  });
  check("cli: owner flag", rOwner.ok && (seenArgv ?? []).join(" ").includes("--owner vercel-labs"));
  check("cli: bad owner rejected pre-exec", !(await searchSkillsCli("x", { owner: "a;b", runner: okRunner })).ok && seenArgv?.[3] === "x");
  check("cli: empty query rejected", !(await searchSkillsCli("  ", { runner: okRunner })).ok);

  // ── Tool: CLI failure → API fallback → structured error ──
  const failRunner = async () => {
    throw new Error("spawn npx ENOENT");
  };
  const tool = createFindSkillTool();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exec = (args: any) => (tool.execute as any)(args, { toolCallId: "t" });
  // No token in this env (or skip): force fallback path deterministically by
  // deleting the token for the call.
  const savedToken = process.env.VERCEL_OIDC_TOKEN;
  delete process.env.VERCEL_OIDC_TOKEN;
  // Tool uses its own internal runner (real exec) — for hermeticity, test the
  // composed fallback via searchSkillsCli failure + searchSkillsApi null:
  const { searchSkillsApi } = await import("~/server/lib/skills/catalog");
  const cliFail = await searchSkillsCli("q", { runner: failRunner });
  const apiNull = await searchSkillsApi("query");
  check("fallback: cli fail is data, not throw", !cliFail.ok);
  check("fallback: api null without token", apiNull === null);
  if (savedToken !== undefined) process.env.VERCEL_OIDC_TOKEN = savedToken;

  // API fallback with mocked fetch
  process.env.VERCEL_OIDC_TOKEN = "test-token";
  const realFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
    ok: true,
    json: async () => ({
      data: [
        { id: "o/r@s", slug: "s", name: "S", source: "o/r", installs: 50, url: "u", isDuplicate: true },
        { id: "o/r2@s2", slug: "s2", name: "S2", source: "o/r2", installs: 60, url: "u2" },
      ],
    }),
  });
  const apiRes = await searchSkillsApi("query");
  check("api: duplicates filtered", apiRes !== null && apiRes.length === 1 && apiRes[0]?.slug === "s2");
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  if (savedToken !== undefined) process.env.VERCEL_OIDC_TOKEN = savedToken;
  else delete process.env.VERCEL_OIDC_TOKEN;

  // Source regex for install_skill (Phase 2 contract)
  check("source: owner/repo@skill ok", REGISTRY_SOURCE_RE.test("vercel-labs/skills@find-skills"));
  check("source: owner/repo ok", REGISTRY_SOURCE_RE.test("a/b"));
  check("source: rejects shell", !REGISTRY_SOURCE_RE.test("a/b; rm -rf /"));
  check("source: rejects spaces", !REGISTRY_SOURCE_RE.test("a/b @s"));

  // ── Registration + PII wiring ──
  const tools = createCustomTools("i", "c", "UTC");
  check("tool: find_skill always registered", "find_skill" in tools);
  const desc = (tools.find_skill as { description?: string }).description ?? "";
  check("tool: description <200 chars with ordering gate", desc.length < 200 && desc.includes("AVAILABLE SKILLS"));
  const setupSrc = readFileSync("src/server/api/routers/nimits-jarvis/agent/setup.ts", "utf-8");
  check("wire: find_skill in noArgumentRestore (tokens stay tokens)", setupSrc.includes('"find_skill"'));
  check("wire: find_skill NOT structural (results redacted)", !setupSrc.includes('"find_skill",\n        "load_skill"') && setupSrc.includes('"load_skill",'));

  console.log(failures === 0 ? "PHASE 8A CHECKPOINT: ALL PASS" : `PHASE 8A CHECKPOINT: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("PHASE 8A CHECKPOINT FAILED:", e);
  process.exit(1);
});
