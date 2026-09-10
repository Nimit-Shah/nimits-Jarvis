/**
 * Phase 4 integration — end-to-end through the REAL database:
 * 1. reconstructMessages on a real conversation → measure §2+§4 savings.
 * 2. ToolResult persistence (as setup.ts does) + read_tool_result round trip.
 */
import { Client } from "pg";
import { db } from "../src/server/clients/db";
import { reconstructMessages } from "../src/server/api/routers/nimits-jarvis/agent/context/build-context";
import { createReadToolResultTool } from "../src/server/api/routers/nimits-jarvis/agent/tools/read-tool-result";

const client = new Client({
  connectionString:
    "postgresql://ayunimusmac@localhost:5432/trustclaw?sslmode=disable",
});

const CHARS_PER_TOKEN = 3.6;

async function main() {
  await client.connect();
  const chat = await client.query(
    `SELECT "chatId" FROM composio_claw_message
     WHERE role='assistant' AND content::text LIKE '%SEARCH_TOOLS%'
     GROUP BY "chatId" ORDER BY MAX("createdAt") DESC LIMIT 1`,
  );
  const chatId = chat.rows[0]?.chatId;
  if (!chatId) {
    console.log("no suitable chat");
    return;
  }
  const res = await client.query(
    `SELECT role, content::text AS c FROM composio_claw_message
     WHERE "chatId" = $1 AND role IN ('user','assistant')
     ORDER BY "createdAt" ASC`,
    [chatId],
  );
  await client.end();

  const rows: Array<{ role: string; content: unknown }> = [];
  for (const row of res.rows) {
    let content: unknown;
    try {
      content = JSON.parse(row.c);
    } catch {
      content = row.c;
    }
    rows.push({
      role: row.role === "assistant" ? "assistant" : "user",
      content,
    });
  }

  const rawChars = rows.reduce(
    (a, r) =>
      a +
      JSON.stringify(r.content).length,
    0,
  );
  const reconstructed = reconstructMessages(rows);
  const afterChars = reconstructed.reduce((a, m) => a + JSON.stringify(m.content).length, 0);
  const toolResultChars = reconstructed
    .filter((m) => m.role === "tool")
    .reduce((a, m) => a + JSON.stringify(m.content).length, 0);

  console.log("── real conversation through reconstructMessages ──");
  console.log(`raw rows chars:       ${rawChars.toLocaleString()}`);
  console.log(`reconstructed chars:  ${afterChars.toLocaleString()} (tool-results: ${toolResultChars.toLocaleString()})`);
  console.log(`saved:                ${(rawChars - afterChars).toLocaleString()} chars (~${Math.round((rawChars - afterChars) / CHARS_PER_TOKEN)} tok)`);

  // ── read_tool_result DB round trip ──
  const instance = await db.composioClawInstance.findFirst({ select: { id: true } });
  if (!instance) return;
  const callId = "harness_rt_" + Date.now();
  const payload = Array.from({ length: 100 }, (_, i) => ({
    id: i,
    name: `item ${i}`,
    email: `u${i}@example.com`,
  }));
  await db.toolResult.create({
    data: {
      instanceId: instance.id,
      chatId: chatId ?? "",
      callId,
      toolName: "COMPOSIO_MULTI_EXECUTE_TOOL",
      payload: payload as unknown as object,
    },
    select: { id: true },
  });
  console.log("── read_tool_result round trip ──");
  const tool = createReadToolResultTool(instance.id);
  const p1 = (await tool.execute!({ callId, offset: 0, limit: 20 } as never)) as any;
  console.log(`page1: total=${p1.total} returned=${p1.returned} truncated=${p1.truncated} hint=${p1.hint ?? "none"}`);
  const p2 = (await tool.execute!({ callId, offset: 20, limit: 20 } as never)) as any;
  console.log(`page2: first item id=${p2.items[0]?.id} returned=${p2.returned} truncated=${p2.truncated}`);
  const forbidden = (await tool.execute!({ callId: "xxxx", offset: 0 } as never)) as any;
  console.log(`unknown callId → error.code=${forbidden.error?.code}`);
  const foreign = await db.toolResult.delete({
    where: { callId },
    select: { id: true },
  }).catch(() => null);
  console.log("cleanup:", foreign ? "deleted" : "already gone");
}

void main();