/**
 * Phase 3 verification — PII redaction byte-stability.
 *
 * The provider cache prefix requires history bytes to be IDENTICAL between
 * requests. PII re-redaction happens per request with a fresh vault; if the
 * DeBERTa classifier's boundary decisions flip between runs, the redacted
 * bytes differ and the cache dies. Redact the same real content twice with
 * two fresh vaults and demand equality.
 */
import { Client } from "pg";
import { PIIVault } from "../src/server/api/routers/nimits-jarvis/agent/pii";

const client = new Client({
  connectionString: "postgresql://ayunimusmac@localhost:5432/trustclaw?sslmode=disable",
});

async function main() {
  await client.connect();
  // Real operator content: the largest user message (pasted chain-of-events)
  // plus a tool result that carried emails/names.
  const userRes = await client.query(
    `SELECT content::text AS c FROM composio_claw_message
     WHERE role='user' ORDER BY LENGTH(content::text) DESC LIMIT 1`,
  );
  const user = JSON.parse(userRes.rows[0].c);
  const userText = user.map((p: { text?: string }) => p.text ?? "").join("\n");

  const toolRes = await client.query(
    `SELECT content::text AS c FROM composio_claw_message
     WHERE role='assistant' AND content::text LIKE '%@%'
     ORDER BY LENGTH(content::text) DESC LIMIT 1`,
  );
  const toolParts = JSON.parse(toolRes.rows[0].c);
  const toolOut = toolParts.find((p: { type?: string; output?: unknown }) => p.type === "dynamic-tool")?.output ?? {};

  await client.end();

  const check = async (label: string, input: string) => {
    const v1 = new PIIVault();
    const r1 = await v1.redact(input);
    const v2 = new PIIVault();
    const r2 = await v2.redact(input);
    const stable = r1 === r2;
    console.log(`${stable ? "STABLE" : "DIFFERS"}  ${label} (${input.length} chars)`);
    if (!stable) {
      let i = 0;
      while (i < r1.length && i < r2.length && r1[i] === r2[i]) i++;
      console.log(`  first diff at ${i}: ...${r1.slice(i - 40, i + 60)}...`);
      console.log(`  vs                 ...${r2.slice(i - 40, i + 60)}...`);
    }
  };

  await check("user paste", userText);
  await check("tool result", JSON.stringify(toolOut).slice(0, 60_000));
}

void main();