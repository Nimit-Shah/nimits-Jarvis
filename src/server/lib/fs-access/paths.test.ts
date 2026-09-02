/**
 * Path-safety unit tests — plain TS, run with:
 *   pnpm exec tsx src/server/lib/fs-access/paths.test.ts
 * Repo convention: no test framework configured; tests are self-asserting
 * modules (same style as agent/pii/__tests__/pii-pipeline.test.ts).
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSafePath } from "./paths";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  // Sandbox root so tests never touch real home credentials
  const sandbox = mkdtempSync(join(tmpdir(), "fs-access-test-"));
  // macOS /tmp is a symlink (/var → /private/var); resolve so expectations match
  const root = realpathSync(sandbox);
  mkdirSync(join(root, "project"), { recursive: true });
  writeFileSync(join(root, "notes.txt"), "hello");
  writeFileSync(join(root, "project", "app.log"), "log line\n");
  writeFileSync(join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(root, "project", "secret.pem"), "PRIVATE KEY");

  console.log("resolveSafePath");
  // 1. normal file under root resolves
  const okFile = await resolveSafePath(join(root, "notes.txt"), root);
  check("normal file under root resolves", okFile.ok && okFile.path === join(root, "notes.txt"), JSON.stringify(okFile));

  // 2. non-existent file under root → ok:true (caller produces NOT_FOUND, not containment error)
  const okMissing = await resolveSafePath(join(root, "does-not-exist.txt"), root);
  check("non-existent under root accepted as path", okMissing.ok && okMissing.path === join(root, "does-not-exist.txt"), JSON.stringify(okMissing));

  // 3. traversal escape refused
  const traversal = await resolveSafePath(join(root, "..", "..", "etc", "passwd"), root);
  check("../../../etc/passwd refused OUTSIDE_ROOT", !traversal.ok && traversal.code === "OUTSIDE_ROOT", JSON.stringify(traversal));

  // 4. symlink inside root pointing outside refused
  symlinkSync("/etc", join(root, "etc-link"));
  const symlinkEscape = await resolveSafePath(join(root, "etc-link", "passwd"), root);
  check("symlink → /etc refused OUTSIDE_ROOT", !symlinkEscape.ok && symlinkEscape.code === "OUTSIDE_ROOT", JSON.stringify(symlinkEscape));

  // 5. innocuous symlink pointing at a DENIED file (exists → realpath resolves
  // into it) — proves the deny-list runs after realpath
  symlinkSync(join(root, "project", "secret.pem"), join(root, "notes-link.txt"));
  const deniedSymlink = await resolveSafePath(join(root, "notes-link.txt"), root);
  check("innocuous symlink → project/secret.pem refused DENIED_PATH", !deniedSymlink.ok && deniedSymlink.code === "DENIED_PATH", JSON.stringify(deniedSymlink));

  // 5b. same but with a missing symlink tail — realpath walks to deepest
  // existing ancestor (the link's parent), still contained
  symlinkSync(join(root, "project", "missing.pem"), join(root, "missing-link.txt"));
  const missingSymlink = await resolveSafePath(join(root, "missing-link.txt"), root);
  check("symlink → missing deny-listed target accepted (contained)", missingSymlink.ok && missingSymlink.path === join(root, "missing-link.txt"), JSON.stringify(missingSymlink));

  // 6. direct deny-list hits (against the real home — resolution only, no reads)
  const sshDir = await resolveSafePath("~/.ssh");
  check("~/.ssh refused DENIED_PATH", !sshDir.ok && sshDir.code === "DENIED_PATH", JSON.stringify(sshDir));

  const dotEnv = await resolveSafePath(join(root, "project", ".env"), root);
  check("project/.env refused DENIED_PATH", !dotEnv.ok && dotEnv.code === "DENIED_PATH", JSON.stringify(dotEnv));

  const pem = await resolveSafePath(join(root, "server.pem"), root);
  check("anything.pem refused DENIED_PATH", !pem.ok && pem.code === "DENIED_PATH", JSON.stringify(pem));

  const keychains = await resolveSafePath("~/Library/Keychains");
  check("~/Library/Keychains refused DENIED_PATH", !keychains.ok && keychains.code === "DENIED_PATH", JSON.stringify(keychains));

  // 7. bad inputs
  const nullByte = await resolveSafePath(`foo\0bar`, sandbox);
  check("null byte refused BAD_PATH", !nullByte.ok && nullByte.code === "BAD_PATH", JSON.stringify(nullByte));

  const empty = await resolveSafePath("", sandbox);
  check("empty input refused BAD_PATH", !empty.ok && empty.code === "BAD_PATH");

  // cleanup
  rmSync(sandbox, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
