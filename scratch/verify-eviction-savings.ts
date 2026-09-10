/**
 * Phase 2 verification harness — measure §2.1 + §2.2 savings on a REAL
 * conversation that used COMPOSIO_SEARCH_TOOLS followed by MULTI_EXECUTE.
 * Exercises the actual eviction module (tool-evict.ts) part-by-part.
 */
import { Client } from "pg";
import {
  collectInvokedSlugs,
  collapseSpentSearchResult,
  stripToolResultBoilerplate,
  SEARCH_TOOLS,
  MULTI_EXECUTE_TOOL,
} from "../src/server/api/routers/nimits-jarvis/agent/tool-evict";

const client = new Client({
  connectionString: "postgresql://ayunimusmac@localhost:5432/trustclaw?sslmode=disable",
});

const CHARS_PER_TOKEN = 3.6;

function charsOf(v: unknown): number {
  return JSON.stringify(v)?.length ?? 0;
}

async function main() {
  await client.connect();

  // Pick the most recent chat that actually used SEARCH_TOOLS then executed.
  const chat = await client.query(
    `SELECT "chatId" FROM composio_claw_message
     WHERE role='assistant' AND content::text LIKE '%SEARCH_TOOLS%'
     GROUP BY "chatId" ORDER BY MAX("createdAt") DESC LIMIT 1`,
  );
  const chatId = chat.rows[0]?.chatId;
  if (!chatId) {
    console.log("no chat with SEARCH_TOOLS found");
    await client.end();
    return;
  }

  const res = await client.query(
    `SELECT role, content::text AS c FROM composio_claw_message
     WHERE "chatId" = $1 AND role IN ('user','assistant')
     ORDER BY "createdAt" ASC`,
    [chatId],
  );
  await client.end();

  const adapted: Array<{ role: string; content: unknown }> = [];
  for (const row of res.rows) {
    let content: unknown;
    try {
      content = JSON.parse(row.c);
    } catch {
      content = row.c;
    }
    adapted.push({ role: row.role === "assistant" ? "assistant" : "user", content });
  }

  const invoked = collectInvokedSlugs(adapted);
  console.log("invoked slugs:", [...invoked].length);

  let rawChars = 0;
  let afterChars = 0;
  let collapsed = 0;
  let keptWhole = 0;
  let searchRaw = 0;
  let searchAfter = 0;

  for (const msg of adapted) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as Array<Record<string, unknown>>) {
      if (part.type !== "dynamic-tool") continue;
      const out = part.output as Record<string, unknown> | undefined;
      if (!out || typeof out !== "object") continue;
      const rawLen = charsOf(part.output);
      rawChars += rawLen;

      let after: unknown = part.output;
      if (part.toolName === SEARCH_TOOLS) {
        searchRaw += rawLen;
        const stub = collapseSpentSearchResult(part.input, part.output, invoked);
        if (stub) {
          after = stub.value;
          afterChars += charsOf(stub.value);
          collapsed++;
          searchAfter += charsOf(stub.value);
          continue;
        }
        keptWhole++;
        after = stripToolResultBoilerplate(part.output);
        searchAfter += charsOf(after);
      } else if (part.toolName === MULTI_EXECUTE_TOOL) {
        after = stripToolResultBoilerplate(part.output);
      }
      afterChars += charsOf(after);
    }
  }

  const fmt = (n: number) => n.toLocaleString("en-US");
  console.log("── §2 lossless eviction on real conversation ──");
  console.log(`raw tool-result chars:     ${fmt(rawChars)} (~${Math.round(rawChars / CHARS_PER_TOKEN)} tok)`);
  console.log(`after eviction:            ${fmt(afterChars)} (~${Math.round(afterChars / CHARS_PER_TOKEN)} tok)`);
  console.log(`saved:                     ${fmt(rawChars - afterChars)} chars (~${Math.round((rawChars - afterChars) / CHARS_PER_TOKEN)} tok)`);
  console.log(`SEARCH_TOOLS: raw ${fmt(searchRaw)} → after ${fmt(searchAfter)} | collapsed ${collapsed}, kept whole ${keptWhole}`);
}

void main();