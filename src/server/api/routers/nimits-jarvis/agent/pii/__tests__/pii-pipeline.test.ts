import { PIIVault, containsTokenPattern, isTokenString } from "../pii-tokenizer";
import { PIITransportShield } from "../pii-transport-shield";
import { scanForPII, scanForPIIEnhanced, extractStructuredPII } from "../pii-scanner";
import { IdentityRegistry } from "../identity-registry";
import { classifyPII, resetDeBERTa, forceCircuitOpen } from "../deberta-classifier";

// ─── Test Helpers ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    const result = fn();
    if (result instanceof Promise) {
      await result;
    }
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEqual(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ─── Tests ────────────────────────────────────────────────────────

async function runAllTests() {
  // ── PII Scanner (Layer 2: Regex) ──
  console.log("\n=== PII Scanner (Layer 2: Regex) ===\n");

  await runTest("detects email", () => {
    const matches = scanForPII("Contact me at john@example.com");
    assert(matches.length === 1, `expected 1 match, got ${matches.length}`);
    assert(matches[0]!.type === "email", `expected email, got ${matches[0]!.type}`);
    assert(matches[0]!.value === "john@example.com", `expected john@example.com, got ${matches[0]!.value}`);
  });

  await runTest("detects phone number", () => {
    const matches = scanForPII("Call me at +1 (234) 567-8901");
    assert(matches.length === 1, `expected 1 match, got ${matches.length}`);
    assert(matches[0]!.type === "phone", `expected phone, got ${matches[0]!.type}`);
  });

  await runTest("detects SSN", () => {
    const matches = scanForPII("SSN: 123-45-6789");
    assert(matches.length === 1, `expected 1 match, got ${matches.length}`);
    assert(matches[0]!.type === "ssn", `expected ssn, got ${matches[0]!.type}`);
  });

  await runTest("detects API key", () => {
    const matches = scanForPII("Key: sk-abcdefghijklmnopqrstuvwxyz123456");
    assert(matches.length === 1, `expected 1 match, got ${matches.length}`);
    assert(matches[0]!.type === "api_key", `expected api_key, got ${matches[0]!.type}`);
  });

  await runTest("detects LinkedIn URL", () => {
    const matches = scanForPII("Profile: https://linkedin.com/in/johndoe");
    assert(matches.length === 1, `expected 1 match, got ${matches.length}`);
    assert(matches[0]!.type === "linkedin_url", `expected linkedin_url, got ${matches[0]!.type}`);
  });

  await runTest("detects URN", () => {
    const matches = scanForPII("URN: urn:li:person:12345");
    assert(matches.length === 1, `expected 1 match, got ${matches.length}`);
    assert(matches[0]!.type === "urn", `expected urn, got ${matches[0]!.type}`);
  });

  await runTest("returns empty for no PII", () => {
    const matches = scanForPII("Hello world, how are you?");
    assert(matches.length === 0, `expected 0 matches, got ${matches.length}`);
  });

  await runTest("does not match phone in resource ID", () => {
    // Resource IDs like "otherContacts/c12345678903626338" should not trigger phone match
    const matches = scanForPII("resource ID is otherContacts/c12345678903626338");
    const phones = matches.filter((m) => m.type === "phone");
    assert(phones.length === 0, `expected no phone match in resource ID, got ${JSON.stringify(phones)}`);
  });

  await runTest("still matches real phone numbers", () => {
    const matches = scanForPII("Call +1 (234) 567-8901 for support");
    assert(matches.length >= 1, `expected at least 1 match, got ${matches.length}`);
    const phones = matches.filter((m) => m.type === "phone");
    assert(phones.length >= 1, `expected phone match, got ${JSON.stringify(phones)}`);
  });

  // ── Structural Extraction (Layer 4) ──
  console.log("\n=== Structural Extraction (Layer 4) ===\n");

  await runTest("extracts from Gmail-style JSON", () => {
    const obj = {
      from: { emailAddress: { name: "Nimit Shah", address: "nimit@example.com" } },
      subject: "Hello",
    };
    const matches = extractStructuredPII(obj);
    const names = matches.filter((m) => m.type === "person_name");
    const emails = matches.filter((m) => m.type === "email");
    assert(names.length >= 1, `expected at least 1 name, got ${names.length}`);
    assert(emails.length >= 1, `expected at least 1 email, got ${emails.length}`);
  });

  await runTest("extracts from Calendar-style JSON", () => {
    const obj = {
      attendees: [
        { name: "John Doe", email: "john@example.com" },
        { name: "Jane Smith", email: "jane@example.com" },
      ],
      organizer: { name: "Bob", email: "bob@example.com" },
    };
    const matches = extractStructuredPII(obj);
    const names = matches.filter((m) => m.type === "person_name");
    assert(names.length >= 3, `expected at least 3 names, got ${names.length}`);
  });

  await runTest("returns empty for non-PII object", () => {
    const obj = { id: "123", status: "active", count: 42 };
    const matches = extractStructuredPII(obj);
    assert(matches.length === 0, `expected 0 matches, got ${matches.length}`);
  });

  // ── PIIVault (Tokenizer) ──
  console.log("\n=== PIIVault (Tokenizer) ===\n");

  await runTest("email token uses domain format", () => {
    const vault = new PIIVault();
    const token = vault.registerPII("email", "test@example.com");
    assert(token.includes("@trustclaw.anon"), `expected @trustclaw.anon token, got ${token}`);
    assert(token.startsWith("CLAW_EMAIL_"), `expected CLAW_EMAIL_* token, got ${token}`);
    assert(!token.startsWith("["), `email token should not have brackets, got ${token}`);
  });

  await runTest("non-email tokens use bracket format", () => {
    const vault = new PIIVault();
    const nameToken = vault.registerPII("person_name", "John Doe");
    assert(nameToken.startsWith("[CLAW_"), `expected [CLAW_* token, got ${nameToken}`);
    assert(nameToken.endsWith("]"), `expected token to end with ], got ${nameToken}`);
    const phoneToken = vault.registerPII("phone", "+1 234 567 8901");
    assert(phoneToken.startsWith("[CLAW_"), `expected [CLAW_* token, got ${phoneToken}`);
    assert(phoneToken.endsWith("]"), `expected token to end with ], got ${phoneToken}`);
    const ssnToken = vault.registerPII("ssn", "123-45-6789");
    assert(ssnToken.startsWith("[CLAW_"), `expected [CLAW_* token, got ${ssnToken}`);
    assert(ssnToken.endsWith("]"), `expected token to end with ], got ${ssnToken}`);
  });

  await runTest("deduplicates same value", () => {
    const vault = new PIIVault();
    const token1 = vault.registerPII("email", "test@example.com");
    const token2 = vault.registerPII("email", "test@example.com");
    assert(token1 === token2, `expected same token, got ${token1} vs ${token2}`);
  });

  await runTest("different values get different tokens", () => {
    const vault = new PIIVault();
    const token1 = vault.registerPII("email", "a@example.com");
    const token2 = vault.registerPII("email", "b@example.com");
    assert(token1 !== token2, `expected different tokens, got ${token1} vs ${token2}`);
  });

  await runTest("hasRedactions reflects state", () => {
    const vault = new PIIVault();
    assert(!vault.hasRedactions, "expected no redactions initially");
    vault.registerPII("email", "test@test.com");
    assert(vault.hasRedactions, "expected redactions after register");
  });

  // ── Async PIIVault Tests ──
  console.log("\n=== PIIVault Async (redact/restore) ===\n");

  await runTest("redact replaces PII in text", async () => {
    const vault = new PIIVault();
    const result = await vault.redact("Email me at john@example.com");
    assert(!result.includes("john@example.com"), `expected PII redacted, got: ${result}`);
    assert(result.includes("CLAW_"), `expected CLAW token, got: ${result}`);
  });

  await runTest("restore reverses redaction", async () => {
    const vault = new PIIVault();
    const redacted = await vault.redact("Email: john@example.com");
    const restored = vault.restore(redacted);
    assert(restored.includes("john@example.com"), `expected restored email, got: ${restored}`);
    assert(!restored.includes("CLAW_"), `expected no CLAW tokens, got: ${restored}`);
  });

  await runTest("deep redact works on nested objects", async () => {
    const vault = new PIIVault();
    const input = { from: { email: "user@test.com", name: "Test User" }, body: "Hello world" };
    const redacted = await vault.redactToolResult(input);
    const json = JSON.stringify(redacted);
    assert(!json.includes("user@test.com"), `expected email redacted, got: ${json}`);
  });

  await runTest("deep restore reverses deep redact", async () => {
    const vault = new PIIVault();
    const input = { to: "user@test.com", message: "Hello" };
    const redacted = await vault.redactToolResult(input);
    const restored = vault.restoreDeep(redacted) as Record<string, unknown>;
    assertEqual(restored.to, "user@test.com", "deep restore should recover original email");
  });

  await runTest("deep redact handles 15-level nested object", async () => {
    const vault = new PIIVault();
    // Build a deeply nested object
    let obj: unknown = { value: "john@example.com" };
    for (let i = 0; i < 15; i++) {
      obj = { nested: obj };
    }
    const redacted = await vault.redactToolResult(obj);
    const json = JSON.stringify(redacted);
    assert(!json.includes("john@example.com"), `email should be redacted at depth 15, got: ${json}`);
    assert(json.includes("@trustclaw.anon") || json.includes("[CLAW_"), `should contain token, got: ${json}`);
  });

  await runTest("deepRestore handles 15-level nested object", async () => {
    const vault = new PIIVault();
    const token = vault.registerPII("email", "john@example.com");
    // Build deeply nested object with token at leaf
    let obj: unknown = { value: token };
    for (let i = 0; i < 15; i++) {
      obj = { nested: obj };
    }
    const restored = vault.restoreDeep(obj) as Record<string, unknown>;
    // Walk to innermost value
    let inner: unknown = restored;
    for (let i = 0; i < 15; i++) {
      inner = (inner as Record<string, unknown>).nested;
    }
    const innerVal = (inner as Record<string, unknown>).value as string;
    assertEqual(innerVal, "john@example.com", "should restore email at depth 15");
  });

  // ── Canonicalization ──
  console.log("\n=== Vault Canonicalization ===\n");

  await runTest("same value different casing produces same token", () => {
    const vault = new PIIVault();
    const token1 = vault.registerPII("email", "John@Example.COM");
    const token2 = vault.registerPII("email", "john@example.com");
    assert(token1 === token2, `expected same token for case variants, got ${token1} vs ${token2}`);
  });

  await runTest("restore preserves first-seen casing", async () => {
    const vault = new PIIVault();
    const token = vault.registerPII("email", "John@Example.COM");
    // Later registration of different case returns same token
    vault.registerPII("email", "john@example.com");
    const restored = vault.restore(`Contact ${token}`);
    assert(restored === "Contact John@Example.COM", `expected first-seen casing, got: ${restored}`);
  });

  await runTest("same value different whitespace produces same token", () => {
    const vault = new PIIVault();
    const token1 = vault.registerPII("person_name", "Nimit  Shah");
    const token2 = vault.registerPII("person_name", "Nimit Shah");
    assert(token1 === token2, `expected same token for whitespace variants, got ${token1} vs ${token2}`);
  });

  await runTest("canonical redact catches case variant via scanner", async () => {
    const vault = new PIIVault();
    // Register lowercase version via structured extraction
    vault.registerPII("email", "john@example.com");
    // Text contains uppercase variant — should still be caught
    const result = await vault.redact("Email: JOHN@EXAMPLE.COM");
    assert(!result.includes("JOHN@EXAMPLE.COM"), `expected uppercase redacted, got: ${result}`);
    assert(result.includes("CLAW_"), `expected CLAW token, got: ${result}`);
    // Restore should use original first-seen casing
    const restored = vault.restore(result);
    assert(restored.includes("john@example.com"), `expected restored to use first-seen casing, got: ${restored}`);
  });

  // ── Session Isolation ──
  console.log("\n=== Session Isolation ===\n");

  await runTest("vault counters are independent", () => {
    const vault1 = new PIIVault();
    const vault2 = new PIIVault();
    // Each vault starts at counter 1, so same type+index produces same token.
    // Independence means: vault1 has a different token than vault2 for the same
    // value at different counter positions.
    vault2.registerPII("email", "other@example.com"); // vault2 counter now at 2
    const token1 = vault1.registerPII("email", "test@example.com");
    const token2 = vault2.registerPII("email", "test@example.com");
    assert(token1 !== token2, `expected different tokens, got ${token1} vs ${token2}`);
  });

  await runTest("vaults do not share mappings", () => {
    const vault1 = new PIIVault();
    const vault2 = new PIIVault();
    vault1.registerPII("email", "secret@example.com");
    assert(!vault2.hasRedactions, "vault2 should have no redactions");
  });

  // ── containsTokenPattern ──
  console.log("\n=== containsTokenPattern ===\n");

  await runTest("detects standalone token", () => {
    assert(containsTokenPattern("text [CLAW_EMAIL_A1B2] more text"), "should detect standalone token");
  });

  await runTest("detects token embedded in code string", () => {
    const code = 'const email = "[CLAW_EMAIL_A1B2]"; send(email);';
    assert(containsTokenPattern(code), "should detect token embedded in code");
  });

  await runTest("detects token with multi-word type", () => {
    assert(containsTokenPattern("[CLAW_PERSON_NAME_A1B2]"), "should detect PERSON_NAME token");
    assert(containsTokenPattern("[CLAW_CREDIT_CARD_A1B2]"), "should detect CREDIT_CARD token");
    assert(containsTokenPattern("[CLAW_IP_ADDRESS_A1B2]"), "should detect IP_ADDRESS token");
    assert(containsTokenPattern("[CLAW_LINKEDIN_URL_A1B2]"), "should detect LINKEDIN_URL token");
  });

  await runTest("returns false for text without tokens", () => {
    assert(!containsTokenPattern("Hello world"), "should return false for plain text");
    assert(!containsTokenPattern("text [NOT_A_TOKEN] more"), "should return false for non-CLAW brackets");
  });

  await runTest("detects multiple tokens", () => {
    const text = "email [CLAW_EMAIL_A1B2] and name [CLAW_PERSON_NAME_C3D4]";
    assert(containsTokenPattern(text), "should detect any token in mixed text");
  });

  await runTest("detects email domain format token", () => {
    assert(containsTokenPattern("CLAW_EMAIL_A1B2@trustclaw.anon"), "should detect email domain token");
    assert(containsTokenPattern("prefix CLAW_EMAIL_C3D4@trustclaw.anon suffix"), "should detect email token in text");
  });

  await runTest("detects mixed format tokens", () => {
    assert(containsTokenPattern("email: CLAW_EMAIL_A1B2@trustclaw.anon, name: [CLAW_PERSON_NAME_C3D4]"), "should detect both formats");
  });

  await runTest("detects email token in code string", () => {
    const code = 'const email = "CLAW_EMAIL_A1B2@trustclaw.anon";';
    assert(containsTokenPattern(code), "should detect email token embedded in code");
  });

  // ── isTokenString ──
  console.log("\n=== isTokenString ===\n");

  await runTest("detects bracket format", () => {
    assert(isTokenString("[CLAW_EMAIL_A1B2]"), "should detect bracket token");
    assert(isTokenString("[CLAW_PERSON_NAME_A1B2]"), "should detect PERSON_NAME bracket token");
  });

  await runTest("detects email domain format", () => {
    assert(isTokenString("CLAW_EMAIL_A1B2@trustclaw.anon"), "should detect email domain token");
  });

  await runTest("returns false for non-token strings", () => {
    assert(!isTokenString("hello world"), "should return false for plain text");
    assert(!isTokenString("[NOT_A_TOKEN]"), "should return false for non-CLAW brackets");
    assert(!isTokenString("user@other-domain.com"), "should return false for plain email");
  });

  // ── Checkpoint 2: Tool Args Restore ──
  console.log("\n=== Checkpoint 2: Tool Args Deep Restore ===\n");

  await runTest("deepRestore restores tokens in nested tool input", async () => {
    const vault = new PIIVault();
    // Simulate: LLM received redacted data, puts tokens in tool call args
    const token = vault.registerPII("email", "real@example.com");
    const toolInput = {
      to: token,
      subject: "Hello",
      body: `Contact ${token} for details`,
    };
    const restored = vault.restoreDeep(toolInput) as typeof toolInput;
    assertEqual(restored.to, "real@example.com", "should restore email in to field");
    assert(restored.body.includes("real@example.com"), "should restore email in body");
    assert(!restored.body.includes(token), "should have no tokens in body");
  });

  await runTest("deepRestore handles arrays in tool input", async () => {
    const vault = new PIIVault();
    const token = vault.registerPII("email", "a@b.com");
    const input = { recipients: [token, "other@test.com"], cc: [] };
    const restored = vault.restoreDeep(input) as typeof input;
    assertEqual(restored.recipients[0], "a@b.com", "should restore email in array");
  });

  await runTest("deepRestore is idempotent on non-token strings", () => {
    const vault = new PIIVault();
    const input = { key: "some random text", num: 42, flag: true };
    const restored = vault.restoreDeep(input) as typeof input;
    assertEqual(restored.key, "some random text", "should not modify non-token strings");
    assertEqual(restored.num, 42, "should not modify numbers");
    assertEqual(restored.flag, true, "should not modify booleans");
  });

  // ── Transport Shield ──
  console.log("\n=== Transport Shield ===\n");

  await runTest("scrubs text content", async () => {
    const vault = new PIIVault();
    vault.registerPII("email", "secret@test.com");
    const shield = new PIITransportShield(vault);
    const msg = { role: "user" as const, content: "My email is secret@test.com" };
    const scrubbed = await shield.scrubMessage(msg);
    assert(!scrubbed.content.includes("secret@test.com"), `expected scrubbed, got: ${scrubbed.content}`);
  });

  await runTest("scrubText works", async () => {
    const vault = new PIIVault();
    vault.registerPII("email", "secret@test.com");
    const shield = new PIITransportShield(vault);
    const result = await shield.scrubText("Email: secret@test.com");
    assert(!result.includes("secret@test.com"), `expected scrubbed, got: ${result}`);
  });

  // ── SSE Restore ──
  console.log("\n=== SSE Restore (Chunk Boundary) ===\n");

  await runTest("restore handles multiple tokens", async () => {
    const vault = new PIIVault();
    const redacted = await vault.redact("Email: a@test.com and b@test.com");
    const restored = vault.restore(redacted);
    assert(restored.includes("a@test.com"), `expected first email, got: ${restored}`);
    assert(restored.includes("b@test.com"), `expected second email, got: ${restored}`);
  });

  await runTest("restore handles multi-word type tokens", () => {
    const vault = new PIIVault();
    const token = vault.registerPII("person_name", "John Doe");
    const result = vault.restore(`Name: ${token}`);
    assertEqual(result, "Name: John Doe", "should restore PERSON_NAME token");
  });

  // ── Identity Registry ──
  console.log("\n=== Identity Registry (Layer 1) ===\n");

  await runTest("singleton pattern", () => {
    IdentityRegistry.reset();
    const r1 = IdentityRegistry.getInstance();
    const r2 = IdentityRegistry.getInstance();
    assert(r1 === r2, "expected same instance");
  });

  await runTest("getExactMatches returns sorted by length", () => {
    IdentityRegistry.reset();
    const registry = IdentityRegistry.getInstance();
    const matches = registry.getExactMatches();
    for (let i = 1; i < matches.length; i++) {
      assert(
        matches[i - 1]!.literal.length >= matches[i]!.literal.length,
        `expected sorted by length, got ${matches[i - 1]!.literal} before ${matches[i]!.literal}`,
      );
    }
  });

  // ── Integration ──
  console.log("\n=== Integration: Full Redact → Restore Cycle ===\n");

  await runTest("email redaction and restoration", async () => {
    const vault = new PIIVault();
    const input = "My email is john@example.com and my SSN is 123-45-6789";
    const redacted = await vault.redact(input);
    assert(!redacted.includes("john@example.com"), `email should be redacted: ${redacted}`);
    assert(!redacted.includes("123-45-6789"), `SSN should be redacted: ${redacted}`);
    assert(redacted.includes("CLAW_"), `should contain CLAW tokens: ${redacted}`);
    const restored = vault.restore(redacted);
    assert(restored.includes("john@example.com"), `email should be restored: ${restored}`);
    assert(restored.includes("123-45-6789"), `SSN should be restored: ${restored}`);
  });

  await runTest("structured + text PII", async () => {
    const vault = new PIIVault();
    vault.registerStructuredPII({
      from: { name: "Nimit Shah", email: "nimit@test.com" },
    });
    const text = "Got email from Nimit Shah at nimit@test.com";
    const redacted = await vault.redact(text);
    assert(!redacted.includes("Nimit Shah"), `name should be redacted: ${redacted}`);
    assert(!redacted.includes("nimit@test.com"), `email should be redacted: ${redacted}`);
    const restored = vault.restore(redacted);
    assert(restored.includes("Nimit Shah"), `name should be restored: ${restored}`);
    assert(restored.includes("nimit@test.com"), `email should be restored: ${restored}`);
  });

  await runTest("full cycle with canonicalization", async () => {
    const vault = new PIIVault();
    vault.registerStructuredPII({
      from: { name: "John Doe", email: "John@Example.COM" },
    });
    // Text contains email with different casing (caught by regex scanner)
    // and exact name match (caught by Step 1 string replacement)
    const text = "From: john@example.com (John Doe)";
    const redacted = await vault.redact(text);
    assert(!redacted.includes("John@Example.COM"), `registered casing should be redacted`);
    assert(!redacted.includes("john@example.com"), `lowercase variant should be redacted`);
    assert(!redacted.includes("John Doe"), `name should be redacted: ${redacted}`);
    // Restore returns first-seen (registered) casing
    const restored = vault.restore(redacted);
    assert(restored.includes("John@Example.COM"), `email should restore to registered casing: ${restored}`);
    assert(restored.includes("John Doe"), `name should restore to registered casing: ${restored}`);
  });

  // ── DeBERTa Fail-Closed ──
  console.log("\n=== DeBERTa Fail-Closed ===\n");

  await runTest("classifyPII throws when circuit is open", async () => {
    forceCircuitOpen();
    let threw = false;
    try {
      await classifyPII("This is a test sentence with enough length to trigger classification.");
    } catch {
      threw = true;
    }
    assert(threw, "classifyPII should throw when circuit is open (fail-closed)");
    resetDeBERTa();
  });

  await runTest("classifyPII succeeds when model is available", async () => {
    // Model should be available (cached); verify it returns real results not []
    // This also implicitly re-loads the model after circuit-open reset above
    const result = await classifyPII("My name is John Smith. I live in Chicago.");
    assert(Array.isArray(result), "classifyPII should return results array when model works");
    // With valid PII text, DeBERTa should detect something
    assert(result.length > 0, `expected at least 1 PII detection, got ${result.length}`);
  });

  // ── Summary ──
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

runAllTests();
