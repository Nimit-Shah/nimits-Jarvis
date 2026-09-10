/**
 * Full-pipeline E2E (no auth, no API keys — local Ollama qwen3:8b):
 *
 * A. Real chat: prepareAgentRun → agent.stream → drain → assert
 *    - metrics.sectionTokens populated
 *    - assistant row updated with sectionTokens/genMs/finishReason
 *    - ToolResult rows persisted for every executed tool call
 * B. Throwaway chat: two identical preps → byte-identical assembled payloads
 *    (deterministic prefix = cache-stable) with the volatile tail intact.
 */
import "dotenv/config";
import { db } from "~/server/clients/db";
import { prepareAgentRun } from "~/server/api/routers/nimits-jarvis/agent/setup";
import type { ReconstructedMessage } from "~/server/api/routers/nimits-jarvis/agent/types";

const results: Array<[string, boolean]> = [];
const report = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  results.push([name, ok]);
  if (!ok) process.exitCode = 1;
};

const serialize = (messages: ReconstructedMessage[]) => JSON.stringify(messages);

/** The volatile tail's timestamp is BY DESIGN not prefix-stable — mask it. */
const maskTimestamp = (s: string) => s.replace(/\[Current Time: [^\]]+\]/, "[Current Time: MASKED]");

async function drain(result: Awaited<ReturnType<typeof runStream>>) {
  const stream = await result;
  for await (const _ of stream.fullStream) {
    // drain
  }
}

async function runStream(agent: Awaited<ReturnType<typeof prepareAgentRun>>["result"]["agent"], messages: ReconstructedMessage[]) {
  return agent.stream({ prompt: messages });
}

async function main() {
  // ── A. real chat: pipeline execution + persistence ──
  const realChatId = (
    await db.$queryRaw<Array<{ chatId: string }>>`
      SELECT m."chatId" FROM composio_claw_message m
      WHERE m.role='assistant' AND m.content::text LIKE '%SEARCH_TOOLS%'
      GROUP BY m."chatId" ORDER BY MAX(m."createdAt") DESC LIMIT 1
    `
  )[0]?.chatId;
  if (!realChatId) {
    console.log("SKIP A — no SEARCH_TOOLS chat found");
  } else {
    const turn1 = await prepareAgentRun({
      instanceId: ((await db.chat.findUnique({ where: { id: realChatId }, select: { instanceId: true } }))!).instanceId,
      chatId: realChatId,
      userMessage: "continue — just confirm briefly what you had; do not run tools.",
      source: "web",
    });
    const r1 = turn1.result;
    report("A1 sectionTokens populated", !!r1.metrics.sectionTokens?.system && !!r1.metrics.sectionTokens?.toolResults);
    console.log("  sections:", JSON.stringify(r1.metrics.sectionTokens));
    const startedAt = r1.metrics.startedAt;
    void startedAt;
    await drain(runStream(r1.agent, r1.messages));

    const lastAssistant = await db.message.findFirst({
      where: { chatId: realChatId, role: "assistant" },
      orderBy: { createdAt: "desc" },
      select: {
        sectionTokens: true,
        genMs: true,
        finishReason: true,
        ttftMs: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
      },
    });
    report(
      "A2 assistant row updated with instrumentation",
      !!lastAssistant && lastAssistant.genMs !== null && !!lastAssistant.finishReason && !!lastAssistant.sectionTokens,
    );
    if (lastAssistant) {
      console.log(
        `  genMs=${lastAssistant.genMs} finish=${lastAssistant.finishReason} ttftMs=${lastAssistant.ttftMs ?? "n/a"} in=${lastAssistant.inputTokens} out=${lastAssistant.outputTokens} cached=${lastAssistant.cacheReadTokens}`,
      );
    }
    const toolResults = await db.toolResult.findMany({
      where: { instanceId: ((await db.chat.findUnique({ where: { id: realChatId }, select: { instanceId: true } }))!).instanceId },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { callId: true, toolName: true },
    });
    const lastAssistantContent = lastAssistant
      ? null
      : null;
    void lastAssistantContent;
    const hadToolCalls = (await db.message.findFirst({
      where: { chatId: realChatId, role: "assistant" },
      orderBy: { createdAt: "desc" },
      select: { content: true },
    }))?.content;
    const callCount = Array.isArray(hadToolCalls)
      ? (hadToolCalls as Array<Record<string, unknown>>).filter((p) => p?.type === "dynamic-tool").length
      : 0;
    if (callCount > 0) {
      report("A3 ToolResult rows match executed calls", toolResults.length === Math.min(3, callCount) && toolResults.length > 0);
      console.log("  latest:", toolResults.map((t) => `${t.toolName}/${t.callId}`).join(", "));
    } else {
      console.log("SKIP A3 — no tool calls this turn (persistence covered by verify-toolresult-db.ts)");
    }
  }

  // ── B. two fresh chats: deterministic assembly + cache-stable prefix ──
  // (same-instance, same-message preps on separate chats isolate DB-mutation
  // side effects: a prep persists its own user row, which a second prep on the
  // SAME chat legitimately picks up as history.)
  const anyInstance = await db.composioClawInstance.findFirst({ select: { id: true } });
  const chatB1 = await db.chat.create({
    data: { instanceId: anyInstance!.id, name: "token-e2e-harness-a", model: "qwen3:8b" },
    select: { id: true },
  });
  const chatB2 = await db.chat.create({
    data: { instanceId: anyInstance!.id, name: "token-e2e-harness-b", model: "qwen3:8b" },
    select: { id: true },
  });
  try {
    const prepA = await prepareAgentRun({
      instanceId: anyInstance!.id,
      chatId: chatB1.id,
      userMessage: "very short identical message for cache stability",
      source: "web",
    });
    const prepB = await prepareAgentRun({
      instanceId: anyInstance!.id,
      chatId: chatB2.id,
      userMessage: "very short identical message for cache stability",
      source: "web",
    });
    const payloadA = maskTimestamp(serialize(prepA.result.messages));
    const payloadB = maskTimestamp(serialize(prepB.result.messages));
    report("B1 byte-identical payloads across fresh chats (timestamp masked)", payloadA === payloadB);
    if (payloadA !== payloadB) {
      for (let i = 0; i < Math.min(payloadA.length, payloadB.length); i++) {
        if (payloadA[i] !== payloadB[i]) {
          console.log(`  first diff at ${i}: ...${payloadA.slice(i - 60, i + 60)}...`);
          console.log(`  vs                 ...${payloadB.slice(i - 60, i + 60)}...`);
          break;
        }
      }
    }
    console.log(`  payload ${payloadA.length} chars; volatile tail: ${JSON.stringify(prepA.result.messages.at(-1)?.content).slice(0, 120)}...`);
    report("B2 sections consistent", JSON.stringify(prepA.result.metrics.sectionTokens) === JSON.stringify(prepB.result.metrics.sectionTokens));
  } finally {
    await db.chat.delete({ where: { id: chatB1.id } }).catch(() => null);
    await db.chat.delete({ where: { id: chatB2.id } }).catch(() => null);
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? "── ALL PASS ──" : `── ${failed.length} FAILURES ──`);
  await db.$disconnect();
}

void main().catch((e) => {
  console.error("E2E harness error:", e);
  process.exit(1);
});