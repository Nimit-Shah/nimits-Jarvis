import { filterToolsetByAllowlist } from "../src/server/clients/composio";

function tools(names: string[]) {
  return Object.fromEntries(names.map((n) => [n, { description: n, execute: async () => ({}) }]));
}

const all = tools([
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_WAIT_FOR_CONNECTIONS",
  "COMPOSIO_GMAIL_SEND_EMAIL",
  "COMPOSIO_GMAIL_FETCH_EMAILS",
  "COMPOSIO_GMAIL_GET_PROFILE",
  "COMPOSIO_GITHUB_LIST_COMMITS",
]);

const r: Array<[string, boolean]> = [];

// 1. no allowlist → unchanged
r.push(["no allowlist → full", Object.keys(filterToolsetByAllowlist(all, null)).length === 8]);
r.push(["empty allowlist → full", Object.keys(filterToolsetByAllowlist(all, [])).length === 8]);

// 2. allowlist → only listed + infra, SEARCH_TOOLS gone
const f1 = filterToolsetByAllowlist(all, ["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"]);
const k1 = Object.keys(f1).sort();
r.push([
  "filtered set",
  JSON.stringify(k1) ===
    JSON.stringify([
      "COMPOSIO_GMAIL_FETCH_EMAILS",
      "COMPOSIO_GMAIL_SEND_EMAIL",
      "COMPOSIO_MANAGE_CONNECTIONS",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      "COMPOSIO_WAIT_FOR_CONNECTIONS",
    ]),
]);
r.push(["SEARCH_TOOLS dropped", !("COMPOSIO_SEARCH_TOOLS" in f1)]);

// 3. lowercase/odd-case slug matches (normalization)
const f2 = filterToolsetByAllowlist(all, ["gmail_send_email"]);
r.push(["case-insensitive match", "COMPOSIO_GMAIL_SEND_EMAIL" in f2 && Object.keys(f2).length === 4]);

// 4. no match → full fallback
const f3 = filterToolsetByAllowlist(all, ["SLACK_DOES_NOT_EXIST"]);
r.push(["zero-match → full fallback", Object.keys(f3).length === 8]);

for (const [name, ok] of r) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) process.exitCode = 1;
}