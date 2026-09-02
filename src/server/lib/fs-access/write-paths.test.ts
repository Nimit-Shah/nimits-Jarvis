/**
 * Phase B write-path guard tests — plain TS, run with:
 *   pnpm exec dotenv -e .env -- pnpm exec tsx src/server/lib/fs-access/write-paths.test.ts
 *
 * Covers spec §9 path-guard acceptance: persistence denylist, .git escapes,
 * repo-tree denial (process.cwd()), symlinked final component, system paths.
 * Does NOT cover: parent-missing/2MB/11th-change (caller-level, covered in the
 * tool pre-flight and executeFileChange tests).
 */
import { mkdirSync, mkdtempSync, symlinkSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWritePath } from "./write-paths";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.error(`  ✘ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 240)}` : ""}`); }
}

async function main() {
  const sandbox = mkdtempSync(join(tmpdir(), "fs-write-test-"));
  const root = realpathSync(sandbox);
  mkdirSync(join(root, "project"), { recursive: true });
  mkdirSync(join(root, "project", ".git", "hooks"), { recursive: true });
  mkdirSync(join(root, "project", "node_modules", "pkg"), { recursive: true });

  console.log("resolveWritePath — persistence denylist");
  const zshrc = await resolveWritePath("~/.zshrc", null);
  check("~/.zshrc refused", !zshrc.ok && zshrc.error.code === "PERSISTENCE_DENIED", zshrc);
  const launch = await resolveWritePath("~/Library/LaunchAgents/x.plist", null);
  check("LaunchAgents refused", !launch.ok && launch.error.code === "PERSISTENCE_DENIED", launch);
  const ssh = await resolveWritePath("~/.ssh/authorized_keys", null);
  check("~/.ssh refused", !ssh.ok && (ssh.error.code === "PERSISTENCE_DENIED" || ssh.error.code === "DENIED_PATH"), ssh);

  console.log("resolveWritePath — .git escapes");
  const hook = await resolveWritePath(join(root, "project", ".git", "hooks", "pre-commit"), root);
  check(".git/hooks/pre-commit refused", !hook.ok && hook.error.code === "PERSISTENCE_DENIED", hook);
  const gitconfig = await resolveWritePath(join(root, "project", ".git", "config"), root);
  check(".git/config refused", !gitconfig.ok && gitconfig.error.code === "PERSISTENCE_DENIED", gitconfig);
  const nm = await resolveWritePath(join(root, "project", "node_modules", "pkg", "x.js"), root);
  check("node_modules refused", !nm.ok && nm.error.code === "PERSISTENCE_DENIED", nm);

  console.log("resolveWritePath — repo tree (process.cwd())");
  const repoWrite = await resolveWritePath(join(process.cwd(), "scratch", "injected.txt"), null);
  check("write under process.cwd() refused", !repoWrite.ok && repoWrite.error.code === "REPO_TREE", repoWrite);

  console.log("resolveWritePath — symlinks & system");
  // symlink final component pointing INSIDE the root is still refused
  writeFileSync(join(root, "real.txt"), "x");
  symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
  const sym = await resolveWritePath(join(root, "link.txt"), root);
  check("symlink final component refused SYMLINK_TARGET", !sym.ok && sym.error.code === "SYMLINK_TARGET", sym);
  const sys = await resolveWritePath("/usr/local/bin/evil", null);
  check("/usr refused SYSTEM_PATH", !sys.ok && sys.error.code === "SYSTEM_PATH", sys);

  console.log("resolveWritePath — allowed paths pass through");
  const okNew = await resolveWritePath(join(root, "project", "newfile.txt"), root);
  check("new file under root ok", okNew.ok && okNew.path === join(root, "project", "newfile.txt"), okNew);
  const okExisting = await resolveWritePath(join(root, "real.txt"), root);
  check("existing file under root ok", okExisting.ok, okExisting);

  rmSync(sandbox, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
