/**
 * Phase 3 — live E2E in the DEFAULT project (docs/TOKEN_EFFICIENCY.md §4-B).
 *
 * Gather (fs_read README) → 5 filler turns (tool-using + chat) → "post it on
 * linkedin" with NO content in the chat. The model must compose the post from
 * history. With B, the README carrier survives as a 4,000-char excerpt at
 * age ≥5 instead of a $summarized one-liner.
 *
 * REAL POST — approved by the operator.
 * Cleanup: throwaway chat row deleted at the end (messages cascade).
 */
import "dotenv/config";
import { db } from "~/server/clients/db";
import { prepareAgentRun } from "~/server/api/routers/nimits-jarvis/agent/setup";

const INSTANCE_ID = "cmqw7rhlm0000jarvb0wp0kci"; // default project
const MODEL = "openrouter/deepseek/deepseek-v4-flash-0731";

const TURNS: string[] = [
  // 1 — gather (fs_read README.md, 12,249 B → content carrier)
  "Read ~/nimits-jarvis/README.md fully so you know exactly what this project is and does.",
  // 2 — tool filler (fs_list → non-carrier array)
  "List the files in the ~/nimits-jarvis/docs folder.",
  // 3 — tool filler (memory_search)
  "Search your memories for the recent token-efficiency work we did.",
  // 4 — tool filler (fs_read schema.prisma → carrier #2; ages README by 2)
  "Now also read ~/nimits-jarvis/prisma/schema.prisma.",
  // 5 — tool filler (fs_read AGENTS.md → 1.3 KB non-carrier contrast case)
  "Read ~/nimits-jarvis/AGENTS.md as well.",
  // 6 — pure chat filler (ages README further; no tools)
  "Good — that's everything I need for now.",
  // 7 — final: real post, no content in chat
  ...(process.argv[2] ? [process.argv[2]] : []),
  "post it on linkedin",
];

// Distinctive README phrases the composed post MUST be able to draw from.
const SPOT_CHECKS = ["self-hosted", "Composio", "PII", "Ollama"];

async function main() {
  const instance = await db.composioClawInstance.findUnique({
    where: { id: INSTANCE_ID },
    select: { id: true, fsReadEnabled: true },
  });
  if (!instance) throw new Error("default instance not found");

  const chat = await db.chat.create({
    data: { instanceId: INSTANCE_ID, name: "token-e2e-linkedin", model: MODEL },
    select: { id: true },
  });
  console.log(`[e2e] chat=${chat.id} turns=${TURNS.length}`);

  try {
    for (let i = 0; i < TURNS.length; i++) {
      const userMessage = TURNS[i]!;
      console.log(`\n════ TURN ${i + 1}: ${userMessage.slice(0, 80)}`);
      const prep = await prepareAgentRun({
        instanceId: INSTANCE_ID,
        chatId: chat.id,
        userMessage,
        source: "web",
      });
      const { agent, messages, metrics } = prep.result;
      console.log(
        `[e2e] sections pre-stream: ${JSON.stringify(metrics.sectionTokens)}`,
      );
      const result = await agent.stream({ prompt: messages });
      for await (const _ of result.fullStream) {
        // drain
      }
      console.log(
        `[e2e] turn ${i + 1} done: finish=${result.finishReason} usage=${JSON.stringify(result.usage)}`,
      );
    }

    // ── verification: what did the final turn actually compose? ──
    const lastAssistant = await db.message.findFirst({
      where: { chatId: chat.id, role: "assistant" },
      orderBy: { createdAt: "desc" },
      select: { content: true },
    });
    const parts = Array.isArray(lastAssistant?.content)
      ? (lastAssistant!.content as Array<Record<string, unknown>>)
      : [];
    console.log(`\n════ FINAL TURN ARTIFACTS ════`);
    for (const p of parts) {
      if (p.type === "dynamic-tool") {
        const name = String(p.toolName);
        const input = JSON.stringify(p.input ?? {});
        console.log(
          `TOOL ${name} input[${input.length}]: ${input.slice(0, 600)}`,
        );
      } else if (p.type === "text") {
        console.log(`TEXT: ${String(p.text ?? "").slice(0, 800)}`);
      }
    }

    // Spot-check the composed post against the actual README
    const allText = parts
      .map((p) => JSON.stringify(p.input ?? "") + String(p.text ?? ""))
      .join(" ");
    console.log(`\n════ SPOT CHECKS (README phrases in composed post) ════`);
    for (const phrase of SPOT_CHECKS) {
      console.log(
        `${allText.toLowerCase().includes(phrase.toLowerCase()) ? "FOUND" : "MISSING"}  "${phrase}"`,
      );
    }

    // Verify the excerpt survived into the final request's history
    const rows = await db.message.findMany({
      where: { chatId: chat.id, messageType: "regular" },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true },
    });
    const { reconstructMessages } =
      await import("~/server/api/routers/nimits-jarvis/agent/context/build-context");
    const reconstructed = reconstructMessages(
      rows.slice(0, -1).map((r) => ({ role: r.role, content: r.content })),
    );
    const toolJson = JSON.stringify(
      reconstructed.filter((m) => m.role === "tool"),
    );
    console.log(`\n════ FINAL REQUEST HISTORY (reconstructed) ════`);
    console.log(
      `README excerpt present: ${toolJson.includes("read_tool_result") && toolJson.includes("100% Local")}`,
    );
    console.log(
      `README summarized away: ${toolJson.includes('"$summarized"')}`,
    );
    console.log(`tool-role payload: ${toolJson.length} chars`);
  } finally {
    await db.chat.delete({ where: { id: chat.id } }).catch(() => null);
    console.log(
      `\n[e2e] cleanup: chat ${chat.id} deleted (the LinkedIn post itself stays)`,
    );
    await db.$disconnect();
  }
}

void main().catch((e) => {
  console.error("E2E error:", e);
  process.exit(1);
});
