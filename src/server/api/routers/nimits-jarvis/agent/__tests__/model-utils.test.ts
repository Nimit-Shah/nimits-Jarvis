import { llmTimeoutFor } from "../model-utils";
import { computeSummarizationBudget } from "../context/context-window";
import { keepLastTextFallback } from "../compaction/run-compaction";
import { shouldLookupMemoriesForContext } from "../tools/memory-search";
import type { ReconstructedMessage } from "../types";

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => void): Promise<void> {
  try {
    fn();
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

function assertGt(actual: number, min: number, msg: string) {
  if (!(actual > min)) throw new Error(`${msg}: expected > ${min}, got ${actual}`);
}

async function runAllTests() {
  console.log("\n=== PII/Helper model-utils tests ===\n");

  await runTest("computeSummarizationBudget is model-generalized (not hardcoded)", () => {
    // DeepSeek (64K via mapping) and Gemini (1M) both map to a positive budget;
    // an unknown model uses the 128K default. The point: it always derives from
    // getContextWindow, so swapping models scales automatically.
    const ds = computeSummarizationBudget("deepseek/deepseek-v4-flash");
    const gem = computeSummarizationBudget("google/gemini-2.5-flash");
    const unknown = computeSummarizationBudget("someprovider/some-model");
    assert(ds > 0, "deepseek budget should be positive");
    assert(gem > 0, "gemini budget should be positive");
    assert(unknown > 0, "unknown model budget should be positive");
    assertGt(gem, ds, "1M-window model should have a larger budget than 64K model");
  });

  await runTest("llmTimeoutFor scales with input and respects cap", () => {
    const small = llmTimeoutFor("short text");
    const large = llmTimeoutFor("x".repeat(500_000)); // ~244 * 2KB increments
    assert(small >= 30_000, "base timeout should be >= 30s");
    assertGt(large, small, "large input should get a longer timeout");
    assert(large <= 120_000, "timeout should be capped at 120s");
  });

  await runTest("keepLastTextFallback preserves recent human text", () => {
    const messages: ReconstructedMessage[] = [
      { role: "user", content: "search cetaphil price" },
      {
        role: "assistant",
        content: [{ type: "text", text: "BigBasket: 450, HealthKart: 420" }],
      },
      { role: "tool", content: [] as never },
      { role: "user", content: "send me the link" },
    ];
    const fallback = keepLastTextFallback(messages, 5);
    assert(fallback !== null, "fallback should not be null");
    assert(
      fallback!.includes("send me the link") && fallback!.includes("cetaphil"),
      `fallback should keep recent text: ${fallback}`,
    );
    assert(
      !fallback!.includes("[Tool result"),
      "fallback should not include tool-result serialization",
    );
  });

  await runTest("keepLastTextFallback returns null when no text content", () => {
    const messages: ReconstructedMessage[] = [
      { role: "tool", content: [] as never },
      { role: "tool", content: [] as never },
    ];
    const fallback = keepLastTextFallback(messages, 5);
    assert(fallback === null, "should return null when no user/assistant text");
  });

  await runTest("shouldLookupMemoriesForContext triggers on backward reference", () => {
    const triggers = [
      "what did we discuss earlier about the PII vault",
      "do you remember my email preference",
      "that thing from last time",
      "you said we should use postgres",
      "as we discussed about the api",
      "can you remind me what we decided",
    ];
    for (const t of triggers) {
      assert(shouldLookupMemoriesForContext(t), `should lookup for: ${t}`);
    }
  });

  await runTest("shouldLookupMemoriesForContext skips in-flow followups", () => {
    const skips = [
      "send me the link to big basket",
      "thanks that was helpful",
      "ok sounds good",
      "",
      "  ",
    ];
    for (const s of skips) {
      assert(!shouldLookupMemoriesForContext(s), `should skip for: "${s}"`);
    }
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

runAllTests();
