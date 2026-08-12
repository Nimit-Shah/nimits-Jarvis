/**
 * Sample-prompt request-body PII analysis (lightweight, replaces the 100-battery).
 *
 * Simulates prepareAgentRun's redaction path for ONE representative prompt:
 *   identity seed → redact(prompt) → registerStructuredPII(toolResult) →
 *   redactToolResult → transport shield scrubPayload → restore
 * then prints + asserts on the final LLM request body.
 */
import { PIIVault } from "~/server/api/routers/nimits-jarvis/agent/pii/pii-tokenizer";
import { PIITransportShield } from "~/server/api/routers/nimits-jarvis/agent/pii/pii-transport-shield";
import { stripResidualTokens } from "~/server/api/routers/nimits-jarvis/agent/pii/brands";
import {
  deriveChatName,
  isPlaceholderChatName,
} from "~/server/api/routers/nimits-jarvis/agent/chat-name";

function flatten(v: unknown): string {
  return JSON.stringify(v);
}

async function main() {
  const vault = new PIIVault();
  // L1 identity registry equivalent (seeded from identity.yaml in real runs)
  vault.registerPII("person_name", "Nimit Shah");
  vault.registerPII("email", "nimitshah2503@gmail.com");
  vault.registerPII("phone", "+917208392455");

  const prompt =
    "Summarize my inbox. Tell Nimit Shah what nimitshah2503@gmail.com needs about the +917208392455 number.";

  // 1) Redact the user prompt (same as redactContextMessages → user role)
  const redactedPrompt = await vault.redact(prompt);

  // 2) Tool result the agent got back (email body) — register + redact
  const toolResult = {
    from: { name: "Nimit Shah", address: "nimitshah2503@gmail.com" },
    subject: "Need a call",
    body: "Call me at +917208392455 today.",
    threadUrl: "https://mail.google.com/thread/abc123",
  };
  vault.registerStructuredPII(toolResult);
  const redactedResult = await vault.redactToolResult(toolResult);

  // 3) Assemble the exact request body sent to the LLM
  const requestBody = [
    { role: "user", content: redactedPrompt },
    {
      role: "assistant",
      content: [
        { type: "text", text: "On it — let me check." },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "gmail_read_email",
          input: redactedResult,
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "gmail_read_email",
          output: redactedResult,
        },
      ],
    },
  ];

  // 4) Final transport-layer deep scrub (mirrors setup.ts)
  const shield = new PIITransportShield(vault);
  const scrubbed = await shield.scrubPayload(
    requestBody as Parameters<typeof shield.scrubPayload>[0],
  );

  const llmView = flatten(scrubbed);

  console.log("\n=== REDACTED LLM REQUEST BODY ===\n");
  console.log(JSON.stringify(scrubbed, null, 2));
  console.log("\n=== CHAT-NAME DERIVATION ===\n");
  console.log(
    "placeholder? (first chat) ->",
    isPlaceholderChatName("New Chat"),
  );
  console.log(
    "placeholder? (manual rename) ->",
    isPlaceholderChatName("Q3 planning"),
  );
  console.log("derived (web prompt) ->", deriveChatName(prompt));
  console.log(
    "derived (cron wrapped) ->",
    deriveChatName(
      "<scheduled-task>\nSend me a morning digest\n</scheduled-task>",
    ),
  );

  // 5) Restore path (what DB + UI display see)
  const restoredText = stripResidualTokens(vault.restore(redactedPrompt));

  console.log("\n=== ASSERTIONS ===\n");
  let failures = 0;
  const check = (cond: boolean, msg: string) => {
    console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
    if (!cond) failures++;
  };

  // Leaks must be absent from the LLM view
  check(
    !llmView.includes("nimitshah2503@gmail.com"),
    "email redacted from LLM view",
  );
  check(!llmView.includes("+917208392455"), "phone redacted from LLM view");
  check(!llmView.includes("Nimit Shah"), "person name redacted from LLM view");
  // No PARTIAL/mangled tokens: any "CLAW_" occurrence must be a complete,
  // valid token (bracketed [CLAW_TYPE_HASH] or full CLAW_EMAIL_HASH@trustclaw.anon).
  check(
    !/[A-Za-z]{2}\[CLAW_|CLAW_[A-Z_]+_[A-F0-9]{2,3}([^0-9A-F]|$)|CLAW_[A-Z_]+_$/.test(
      llmView,
    ),
    "no partial/mangled tokens in LLM view",
  );

  // Functional values must survive
  check(llmView.includes("abc123"), "functional thread id preserved");
  check(llmView.includes("gmail_read_email"), "tool name preserved");

  // Restore path must return real values
  check(
    restoredText.includes("nimitshah2503@gmail.com"),
    "restore recovers email for DB/UI",
  );
  check(
    restoredText.includes("+917208392455"),
    "restore recovers phone for DB/UI",
  );
  check(
    !/[A-Za-z]{2}\[CLAW_[A-Z_]+_[A-F0-9]{4}\]/.test(restoredText),
    "no letter-mangling after restore",
  );

  // Chat-name derivation sanity
  check(
    isPlaceholderChatName("First chat") === true,
    "First chat is placeholder",
  );
  check(isPlaceholderChatName("") === true, "empty name is placeholder");
  check(
    deriveChatName("a  b\n\nc") === "a b c",
    "whitespace collapsed to one line",
  );
  check(
    deriveChatName("<scheduled-task>\nMorning digest\n</scheduled-task>") ===
      "Morning digest",
    "cron tags stripped",
  );

  console.log(
    `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURES`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
