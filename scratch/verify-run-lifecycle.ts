/* Scratch verification for the run-lifecycle fixes.
 * Run: pnpm exec tsx scratch/verify-run-lifecycle.ts
 * Covers: PIIVault snapshot round-trip + Redis claim/idempotency/heartbeat
 * semantics. Exits non-zero on failure.
 */
import { PIIVault } from "../src/server/api/routers/nimits-jarvis/agent/pii/pii-tokenizer";
import {
  claimChatRun,
  claimIdempotencyKey,
  expireChatRun,
  getStreamingMessage,
  peekIdempotencyKey,
  releaseChatRun,
  setRunAssistant,
  takeRunAssistant,
  getRedis,
} from "../src/server/clients/redis";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.error(`  FAIL: ${name}`);
    failures++;
  }
}

async function main() {
  // ── PIIVault snapshot round-trip ──
  const vault = new PIIVault();
  const token = vault.registerPII("person_name", "Ada Lovelace");
  const text = `Hello ${token}, welcome back`;
  const snap = vault.snapshot();
  const revived = PIIVault.fromSnapshot(JSON.parse(JSON.stringify(snap)));
  check("fromSnapshot returns a vault", revived !== null);
  check(
    "revived vault restores tokens",
    revived !== null &&
      revived.restore(text) === "Hello Ada Lovelace, welcome back",
  );
  check(
    "fromSnapshot rejects garbage",
    PIIVault.fromSnapshot({ nope: 1 }) === null,
  );
  check("fromSnapshot rejects null", PIIVault.fromSnapshot(null) === null);

  // ── Redis run-guard semantics (skipped without Redis) ──
  if (!getRedis()) {
    console.log("  skip: redis helpers (REDIS_URL unset)");
  } else {
    const chatId = `verify-chat-${Date.now()}`;
    const s1 = `stream-1-${Date.now()}`;
    const s2 = `stream-2-${Date.now()}`;
    check("first claim wins", (await claimChatRun(chatId, s1)) === true);
    check("second claim loses", (await claimChatRun(chatId, s2)) === false);
    check(
      "pointer still points at first",
      (await getStreamingMessage(chatId)) === s1,
    );
    check(
      "heartbeat extends owned key",
      (await expireChatRun(chatId, s1, 30)) === true,
    );
    check(
      "heartbeat refuses foreign key",
      (await expireChatRun(chatId, s2, 30)) === false,
    );
    const idem = `idem-${Date.now()}`;
    check(
      "idempotency peek misses first",
      (await peekIdempotencyKey(idem)) === null,
    );
    check(
      "idempotency first claim",
      (await claimIdempotencyKey(idem, s1, chatId)) === null,
    );
    const dup = await claimIdempotencyKey(idem, s2, `other-${chatId}`);
    check(
      "idempotency duplicate returns first stream+chat",
      dup?.streamId === s1 && dup?.chatId === chatId,
    );
    await setRunAssistant(s1, "msg-123");
    check(
      "run-asst mapping round-trips",
      (await takeRunAssistant(s1)) === "msg-123",
    );
    check(
      "run-asst mapping consumed once",
      (await takeRunAssistant(s1)) === null,
    );
    await releaseChatRun(chatId, s1);
    check("release frees the slot", (await claimChatRun(chatId, s2)) === true);
    await releaseChatRun(chatId, s2);
  }

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("all checks passed");
  getRedis()?.disconnect();
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
