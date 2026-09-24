import { APICallError } from "ai";
import { formatStreamError, parseAgentError } from "../error-parser";

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => void): Promise<void> {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${String(e)}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEq(actual: string, expected: string) {
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function apiError(message: string, statusCode?: number): APICallError {
  return new APICallError({
    message,
    statusCode,
    url: "https://openrouter.ai/api/v1/chat/completions",
    requestBodyValues: {},
    isRetryable: false,
  });
}

async function runAllTests() {
  console.log("\n=== error-parser formatStreamError tests ===\n");

  await runTest("OpenRouter guardrail block → operator-actionable message", () => {
    const msg = formatStreamError(
      apiError("Request blocked: prompt injection patterns detected", 403),
    );
    assert(msg.includes("OpenRouter content guardrails"), `got: ${msg}`);
    assert(msg.includes("new chat"), `got: ${msg}`);
  });

  await runTest("401 → invalid API key message", () => {
    const msg = formatStreamError(apiError("Unauthorized", 401));
    assert(msg.includes("API key"), `got: ${msg}`);
  });

  await runTest("402 → out of credits message", () => {
    const msg = formatStreamError(apiError("Payment required", 402));
    assert(msg.includes("credits"), `got: ${msg}`);
  });

  await runTest("403 without guardrail keyword → blocked message", () => {
    const msg = formatStreamError(apiError("Forbidden", 403));
    assert(msg.includes("blocked this request"), `got: ${msg}`);
  });

  await runTest("429 → rate limit message", () => {
    const msg = formatStreamError(apiError("Too many requests", 429));
    assert(msg.includes("Rate limit"), `got: ${msg}`);
  });

  await runTest("5xx → provider error with status", () => {
    const msg = formatStreamError(apiError("Internal server error", 502));
    assert(msg.includes("502"), `got: ${msg}`);
    assert(msg.includes("provider"), `got: ${msg}`);
  });

  await runTest("AbortError → Stopped.", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    assertEq(formatStreamError(err), "Stopped.");
  });

  await runTest("timeout → timeout message", () => {
    const msg = formatStreamError(new Error("Request timed out"));
    assert(msg.includes("timed out"), `got: ${msg}`);
  });

  await runTest("network failure → network message", () => {
    const msg = formatStreamError(new TypeError("fetch failed"));
    assert(msg.includes("Network error"), `got: ${msg}`);
  });

  await runTest("composio JSON error → parseAgentError passthrough", () => {
    const msg = formatStreamError(
      new Error('403 {"error":{"message":"Account not linked"}}'),
    );
    assert(msg.includes("Account not linked"), `got: ${msg}`);
  });

  await runTest("unknown error → bounded excerpt, no stack", () => {
    const err = new Error("something odd happened");
    err.stack = "Error: something odd happened\n    at /secret/path/file.ts:1:1";
    const msg = formatStreamError(err);
    assertEq(msg, "something odd happened");
    assert(!msg.includes("at /secret"), "must not leak stack");
  });

  await runTest("non-error value → generic fallback", () => {
    assertEq(formatStreamError(undefined), "Something went wrong. Please try again.");
    assertEq(formatStreamError({}), "Something went wrong. Please try again.");
  });

  await runTest("parseAgentError still returns generic for unknown", () => {
    assertEq(parseAgentError(new Error("mystery")), "Something went wrong. Please try again.");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

void runAllTests();
