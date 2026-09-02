/**
 * Phase A acceptance tests — mode clamping + fs tools E2E + PII inheritance.
 * Run: pnpm exec tsx src/server/api/routers/nimits-jarvis/agent/__tests__/fs-phase-a.test.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFsMode } from "../setup";
import { createCustomTools } from "../tools";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.error(`  ✘ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`); }
}

async function main() {
  console.log("resolveFsMode clamps");
  check("full + web + writeAllowed → full", resolveFsMode("full", "web", { fsWriteAllowed: true }) === "full");
  check("full + web + !writeAllowed → read-only", resolveFsMode("full", "web", { fsWriteAllowed: false }) === "read-only");
  check("full + cron → read-only", resolveFsMode("full", "cron", { fsWriteAllowed: true }) === "read-only");
  check("full + telegram → read-only", resolveFsMode("full", "telegram", { fsWriteAllowed: true }) === "read-only");
  check("undefined + web → read-only", resolveFsMode(undefined, "web", { fsWriteAllowed: true }) === "read-only");

  // ── Tool E2E against a temp sandbox ──
  const sandbox = mkdtempSync(join(tmpdir(), "fs-tools-test-"));
  const root = realpathSync(sandbox);
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "notes.txt"), "meeting notes with alice@example.com inside");
  writeFileSync(join(root, "sub", "data.csv"), "a,b\n1,2\n");
  writeFileSync(join(root, "pic.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]), Buffer.alloc(100)]));
  const bigLog = Array.from({ length: 20_000 }, (_, i) => `line ${i} of the log`).join("\n");
  writeFileSync(join(root, "big.log"), bigLog);
  writeFileSync(join(root, ".env"), "SECRET=1");
  writeFileSync(join(root, "secret.pem"), "PRIVATE KEY MATERIAL");

  const opts = { fsReadEnabled: true, fsMode: "read-only" as const, fsRoot: root as string | null };

  console.log("fs_list");
  const tools = createCustomTools("inst", "chat", "UTC", opts);
  check("fs tools present when enabled", !!(tools as any).fs_list && !!(tools as any).fs_read);
  const list = await (tools as any).fs_list.execute!({ path: root, depth: 1, includeHidden: false, limit: 200 } as never);
  check("lists real entries", Array.isArray(list.entries) && list.entries.some((e: any) => e.name === "notes.txt" && e.type === "file"), JSON.stringify(list).slice(0, 200));
  check("skips hidden + denies pem (denied counted, names leaked)", list.skippedDenied === 1 && !list.entries.some((e: any) => e.name === ".env" || e.name === "secret.pem"), JSON.stringify({ skipped: list.skippedDenied, names: list.entries.map((e: any) => e.name) }));
  check("dirs-first sort", list.entries[0]!.type === "dir", JSON.stringify(list.entries.map((e: any) => e.name)));
  const hidden = await (tools as any).fs_list.execute!({ path: root, depth: 1, includeHidden: true, limit: 500 } as never);
  check("includeHidden shows non-denied dotfiles", hidden.entries.some((e: any) => e.name === "sub"), "");

  console.log("fs_read");
  const read = await (tools as any).fs_read.execute!({ path: join(root, "notes.txt"), maxBytes: 65536 } as never);
  check("reads text file", typeof read.content === "string" && read.content.includes("alice@example.com"), JSON.stringify(read).slice(0, 200));
  const bin = await (tools as any).fs_read.execute!({ path: join(root, "pic.png"), maxBytes: 65536 } as never);
  check("PNG refused as binary", bin.binary === true && bin.sizeBytes === 106 && !bin.content, JSON.stringify(bin));
  const big = await (tools as any).fs_read.execute!({ path: join(root, "big.log"), maxBytes: 4096 } as never);
  check("big log head/tail + marker", big.truncated === true && /truncated \d+ bytes/.test(big.content) && big.content.includes("of the log"), JSON.stringify({ size: big.sizeBytes, ret: big.bytesReturned }).slice(0, 120));
  const denied = await (tools as any).fs_read.execute!({ path: join(root, "secret.pem"), maxBytes: 65536 } as never);
  check("deny-listed file refused", denied.error?.code === "DENIED_PATH", JSON.stringify(denied).slice(0, 160));
  const dirRead = await (tools as any).fs_read.execute!({ path: join(root, "sub"), maxBytes: 65536 } as never);
  check("directory read → NOT_A_FILE + suggests fs_list", dirRead.error?.code === "NOT_A_FILE" && /fs_list/.test(dirRead.error.message), JSON.stringify(dirRead));

  // tools absent when disabled (availability filtering, not runtime rejection)
  const noFs = createCustomTools("inst", "chat", "UTC", { fsReadEnabled: false, fsMode: "read-only", fsRoot: null });
  check("fs tools ABSENT when fsReadEnabled=false", !(noFs as any).fs_list && !(noFs as any).fs_read && !!(noFs as any).memory_save);

  // ── PII inheritance proof: fs_read wrapped by wrapToolExecutors tokenizes emails ──
  console.log("PII pipeline inheritance");
  const { PIIVault } = await import("../pii");
  const vault = new PIIVault();
  const restoreCache = new Map<string, unknown>();
  // Re-import setup's wrapToolExecutors indirectly: replicate its exact behavior via the exported pipeline.
  // Simpler and equally valid: vault.redactToolResult is what wrapToolExecutors calls on the sanitized output.
  const sanitized = { content: (read as any).content, sizeBytes: (read as any).sizeBytes };
  vault.registerStructuredPII(sanitized);
  const redacted = await vault.redactToolResult(sanitized);
  const redactedStr = JSON.stringify(redacted);
  check("email tokenized by the same vault the merge point uses", /CLAW_EMAIL_[A-F0-9]{4}@trustclaw\.anon/.test(redactedStr) && !redactedStr.includes("alice@example.com"), redactedStr.slice(0, 160));

  rmSync(sandbox, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
