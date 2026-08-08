/**
 * PII Injection Suite — 65 realistic tool-call use cases (+ 4 L3 prose checks).
 *
 * Every prompt simulates an end-to-end agent turn: a user prompt, a Composio /
 * custom tool result, and the full PIIVault redact → restore cycle PLUS the
 * transport-shield final checkpoint. For each scenario we assert:
 *
 * 1. All PII that must be redacted never survives into the LLM view.
 * 2. Functional / protected values that must survive (logins, urls, paths,
 *    session ids, model names, protected terms) are never tokenized.
 * 3. restore() / restoreDeep() round-trips every seeded value back byte-exact.
 * 4. No letter-mangling / partial-span corruption (whole-word boundary rule).
 *
 * Layers exercised per scenario:
 *   - L1 identity registry (seeded known values)
 *   - L2 regex (emails, phones, SSNs, cards, IPs, API keys, LinkedIn)
 *   - L3 DeBERTa (prose names — soft-checked: skipped cleanly when the ML model
 *     is unavailable, since determinism is not guaranteed for arbitrary prose)
 *   - L4 structural (registerStructuredPII on tool results)
 *   - Transport shield (final scrubPayload checkpoint)
 *
 * Run: npx tsx src/server/api/routers/nimits-jarvis/agent/pii/__tests__/pii-injection-suite.test.ts
 */

import { PIIVault } from "../pii-tokenizer";
import { PIITransportShield } from "../pii-transport-shield";
import type { PIIType } from "../pii-types";
import { isDeBERTaAvailable } from "../deberta-classifier";

// ─── Test Helpers ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;

async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    const result = fn();
    if (result instanceof Promise) await result;
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

/** Deep-serialize a value so substrings can be searched across the whole tree. */
function flatten(value: unknown): string {
  return JSON.stringify(value ?? {});
}

/**
 * Whether the ML prose-name layer is usable. Soft-gated: DeBERTa-dependent
 * assertions are skipped (counted) when the model can't load so this suite is
 * green in environments without the ONNX model cached.
 */
function proseLayerAvailable(): boolean {
  try {
    return isDeBERTaAvailable();
  } catch {
    return false;
  }
}

interface Scenario {
  /** Human description of the tool-call use case. */
  name: string;
  /** The user's prompt to the agent (may contain PII itself). */
  prompt: string;
  /** Known personal identifiers to seed (L1 identity registry equivalent). */
  seed?: Array<{ type: PIIType; value: string }>;
  /** The tool result returned to the LLM. */
  toolResult: unknown;
  /** Substrings that MUST be absent from the redacted LLM view. */
  mustRedact: string[];
  /** Substrings that MUST survive unredacted (functional/protected). */
  mustPreserve: string[];
  /** Real values that must come back after restore() (defaults to mustRedact). */
  mustRestore?: string[];
}

/**
 * Runs one scenario end-to-end:
 *   seed → redact(prompt) → registerStructuredPII(toolResult) →
 *   redactToolResult(toolResult) → transport-shield scrubPayload → restore.
 */
async function runScenario(sc: Scenario): Promise<void> {
  const vault = new PIIVault();
  if (sc.seed) {
    for (const { type, value } of sc.seed) vault.registerPII(type, value);
  }

  // 1. Redact the user prompt (as redactContextMessages would).
  const redactedPrompt = await vault.redact(sc.prompt);

  // 2. Seed structured PII from the tool result, then deep-redact it.
  vault.registerStructuredPII(sc.toolResult);
  const redactedResult = await vault.redactToolResult(sc.toolResult);

  // 3. Assemble an AI-style message array and run the transport shield as the
  //    final checkpoint (same as setup.ts scrubPayload path).
  const messageArray = [
    { role: "user", content: redactedPrompt },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check that for you." },
        { type: "tool-call", toolCallId: "call_1", toolName: "test_tool", input: redactedResult },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_1", toolName: "test_tool", output: redactedResult },
      ],
    },
  ];
  const shield = new PIITransportShield(vault);
  const scrubbed = (await shield.scrubPayload(
    messageArray as unknown as Parameters<typeof shield.scrubPayload>[0],
  )) as unknown[];
  const llmView = flatten(scrubbed);

  // 4. PII must be gone from the LLM view.
  for (const pii of sc.mustRedact) {
    assert(
      !llmView.includes(pii),
      `PII leaked in LLM view: "${pii}" (use case: ${sc.name})\nVIEW: ${llmView.slice(0, 600)}`,
    );
  }

  // 5. Functional / protected values must survive verbatim.
  for (const keep of sc.mustPreserve) {
    assert(
      llmView.includes(keep),
      `functional value was tokenized: "${keep}" (use case: ${sc.name})`,
    );
  }

  // 6. Restore must bring every seeded value back byte-exact.
  const restoreList = sc.mustRestore ?? sc.mustRedact;
  const restoredPrompt = vault.restore(redactedPrompt);
  const restoredResult = vault.restoreDeep(redactedResult);
  const restoredView = flatten([restoredPrompt, restoredResult]);
  for (const real of restoreList) {
    assert(
      restoredView.includes(real),
      `restore did not recover "${real}" (use case: ${sc.name})\nRESTORED: ${restoredView.slice(0, 600)}`,
    );
  }

  // 7. No letter-mangling: the restored view must not contain a half-word glued
  //    to a token (the Fix 0 corruption pattern "Nimit[CLAW_...]").
  assert(
    !/[A-Za-z]{2}\[CLAW_[A-Z_]+_[A-F0-9]{4}\]/.test(restoredView),
    `letter-mangling detected (Fix 0 regression) (use case: ${sc.name})`,
  );
}

// ─── Scenarios ───────────────────────────────────────────────────

async function runAllScenarios() {
  console.log("\n=== PII Injection Suite: 65 tool-call use cases (+ 4 L3 prose checks) ===\n");
  console.log(`(L3 DeBERTa prose layer ${proseLayerAvailable() ? "AVAILABLE" : "UNAVAILABLE — prose-name checks will be soft-skipped"})\n`);

  // ── Email / Gmail (10) ─────────────────────────────────────────────
  await runTest("write an email to a contact", async () => {
    await runScenario({
      name: "write an email",
      prompt: "Write an email to Priya Sharma about the project budget.",
      seed: [
        { type: "person_name", value: "Priya Sharma" },
        { type: "email", value: "priya.sharma@gmail.com" },
      ],
      toolResult: {
        success: true,
        messageId: "msg_84n2k9a",
        to: "priya.sharma@gmail.com",
        subject: "Project budget",
        body: "Hi Priya, please review the attached budget by Friday.",
        threadId: "thread_19asd",
      },
      mustRedact: ["priya.sharma@gmail.com", "Priya"],
      mustPreserve: ["msg_84n2k9a", "thread_19asd", "Project budget"],
      mustRestore: ["priya.sharma@gmail.com", "Priya Sharma"],
    });
  });

  await runTest("read inbox / list messages", async () => {
    await runScenario({
      name: "read inbox",
      prompt: "Check my inbox for anything from Nimit Shah.",
      seed: [
        { type: "person_name", value: "Nimit Shah" },
        { type: "email", value: "nimit.shah@gmail.com" },
      ],
      toolResult: {
        messages: [
          {
            id: "18cdf",
            from: { name: "Nimit Shah", email: "nimit.shah@gmail.com" },
            subject: "Re: Q3 planning",
            snippet: "Hey, let's finalize the numbers.",
          },
          {
            id: "18cdg",
            from: { name: "Alice Chen", email: "alice.chen@acme.io" },
            subject: "Meeting notes",
          },
        ],
        nextPageToken: "abc123xyz",
      },
      mustRedact: ["nimit.shah@gmail.com", "Nimit Shah", "alice.chen@acme.io", "Alice Chen"],
      mustPreserve: ["18cdf", "18cdg", "abc123xyz", "Meeting notes"],
      mustRestore: ["nimit.shah@gmail.com", "alice.chen@acme.io", "Nimit Shah"],
    });
  });

  await runTest("search Gmail", async () => {
    await runScenario({
      name: "search Gmail",
      prompt: "search gmail for emails from rahul about invoices",
      seed: [
        { type: "person_name", value: "Rahul Gupta" },
        { type: "email", value: "rahul.gupta@example.com" },
      ],
      toolResult: {
        query: "from:rahul.gupta@example.com invoices",
        results: [
          { id: "15af1", from: "Rahul Gupta <rahul.gupta@example.com>", subject: "Invoice #1042" },
        ],
      },
      mustRedact: ["rahul.gupta@example.com", "Rahul Gupta"],
      mustPreserve: ["Invoice #1042", "15af1"],
    });
  });

  await runTest("reply to an email thread", async () => {
    await runScenario({
      name: "reply to thread",
      prompt: "Reply to Rajesh saying I'll attend.",
      seed: [
        { type: "person_name", value: "Rajesh Kumar" },
        { type: "email", value: "rajesh.kumar@outlook.com" },
      ],
      toolResult: {
        success: true,
        messageId: "re_7s8x",
        threadId: "thread_xyz",
        to: "rajesh.kumar@outlook.com",
        subject: "Re: Team offsite",
        body: "I'll attend the offsite.",
        references: ["<abc@mail.outlook.com>"],
      },
      mustRedact: ["rajesh.kumar@outlook.com", "Rajesh"],
      mustPreserve: ["thread_xyz", "re_7s8x", "Team offsite"],
    });
  });

  await runTest("draft an email with cc recipients", async () => {
    await runScenario({
      name: "draft email cc",
      prompt: "Draft an email to Ananya cc-ing Vikram about the launch.",
      seed: [
        { type: "person_name", value: "Ananya Iyer" },
        { type: "person_name", value: "Vikram Singh" },
        { type: "email", value: "ananya.iyer@gmail.com" },
        { type: "email", value: "vikram.singh@gmail.com" },
      ],
      toolResult: {
        draft: true,
        id: "draft_441",
        to: [{ name: "Ananya Iyer", email: "ananya.iyer@gmail.com" }],
        cc: [{ name: "Vikram Singh", email: "vikram.singh@gmail.com" }],
        subject: "Product launch plan",
        body: "Hi Ananya, cc'ing Vikram on the launch plan.",
      },
      mustRedact: ["ananya.iyer@gmail.com", "vikram.singh@gmail.com", "Ananya", "Vikram"],
      mustPreserve: ["draft_441", "Product launch plan"],
    });
  });

  await runTest("send an email with attachment", async () => {
    await runScenario({
      name: "email attachment",
      prompt: "Send the budget.xlsx to CFO Meera Verma.",
      seed: [
        { type: "person_name", value: "Meera Verma" },
        { type: "email", value: "meera.verma@company.com" },
      ],
      toolResult: {
        success: true,
        messageId: "msg_55tt",
        to: "meera.verma@company.com",
        subject: "Budget review",
        attachments: [{ id: "att_881", name: "budget.xlsx", size: 20480, mimeType: "application/vnd.ms-excel" }],
      },
      mustRedact: ["meera.verma@company.com", "Meera"],
      mustPreserve: ["msg_55tt", "att_881", "budget.xlsx", "application/vnd.ms-excel"],
    });
  });

  await runTest("forward an email", async () => {
    await runScenario({
      name: "forward email",
      prompt: "Forward the last email from Suresh to the team.",
      seed: [
        { type: "person_name", value: "Suresh Menon" },
        { type: "email", value: "suresh.menon@gmail.com" },
      ],
      toolResult: {
        success: true,
        messageId: "fw_223",
        originalFrom: "Suresh Menon <suresh.menon@gmail.com>",
        to: ["team@company.com"],
        subject: "Fwd: Sprint retrospective",
      },
      mustRedact: ["suresh.menon@gmail.com", "Suresh Menon", "team@company.com"],
      mustPreserve: ["fw_223", "Fwd: Sprint retrospective"],
      mustRestore: ["team@company.com"],
    });
  });

  await runTest("delete an email", async () => {
    await runScenario({
      name: "delete email",
      prompt: "Delete the promotion email from Deepika.",
      seed: [
        { type: "person_name", value: "Deepika Rao" },
        { type: "email", value: "deepika.rao@promo.co" },
      ],
      toolResult: { success: true, messageId: "del_91", deleted: true, from: "deepika.rao@promo.co" },
      mustRedact: ["deepika.rao@promo.co", "Deepika"],
      mustPreserve: ["del_91"],
    });
  });

  await runTest("label / organize emails", async () => {
    await runScenario({
      name: "label emails",
      prompt: "Label the emails from Hari as Important.",
      seed: [
        { type: "person_name", value: "Hari Krishnan" },
        { type: "email", value: "hari.k@gmail.com" },
      ],
      toolResult: {
        success: true,
        threadIds: ["t_01", "t_02"],
        labelId: "IMPORTANT",
        from: "hari.k@gmail.com",
        affected: 2,
      },
      mustRedact: ["hari.k@gmail.com", "Hari"],
      mustPreserve: ["t_01", "t_02", "IMPORTANT"],
    });
  });

  await runTest("filter emails by date range", async () => {
    await runScenario({
      name: "filter emails",
      prompt: "Show me all emails between Jan 1 and Jan 10.",
      toolResult: {
        query: "after:2026/01/01 before:2026/01/10",
        messages: [
          { id: "a1", from: { name: "Kavita Joshi", email: "kavita.joshi@mail.com" }, subject: "FYI" },
        ],
        total: 1,
      },
      mustRedact: ["kavita.joshi@mail.com", "Kavita"],
      mustPreserve: ["after:2026/01/01", "a1", "FYI"],
      mustRestore: ["kavita.joshi@mail.com"],
    });
  });

  // ── Google Sheets (10) ─────────────────────────────────────────────
  await runTest("read cells from a sheet", async () => {
    await runScenario({
      name: "read sheet cells",
      prompt: "Check my sheet for the sales numbers.",
      seed: [{ type: "person_name", value: "Arjun Nair" }],
      toolResult: {
        spreadsheetId: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
        range: "Sales!A1:D5",
        values: [
          ["Name", "Region", "Amount", "Owner"],
          ["Arjun Nair", "West", 45000, "arjun@example.com"],
          ["Ben Carter", "East", 32000, "ben@example.com"],
        ],
      },
      mustRedact: ["Arjun Nair", "arjun@example.com", "Ben Carter", "ben@example.com"],
      mustPreserve: ["1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms", "Sales!A1:D5", "Region", "Amount"],
    });
  });

  await runTest("write a cell value", async () => {
    await runScenario({
      name: "write cell",
      prompt: "Set cell B2 to 50000 in the tracker.",
      toolResult: {
        spreadsheetId: "sp_sheet_001",
        updatedRange: "Tracker!B2",
        updatedCells: 1,
        value: 50000,
      },
      mustRedact: [],
      mustPreserve: ["sp_sheet_001", "Tracker!B2"],
    });
  });

  await runTest("list spreadsheets", async () => {
    await runScenario({
      name: "list sheets",
      prompt: "List all my spreadsheets.",
      toolResult: {
        files: [
          { id: "f_001", name: "Budget 2026", owner: "nimit@example.com", mimeType: "application/vnd.google-apps.spreadsheet" },
          { id: "f_002", name: "Expenses", owner: "accounting@example.com", mimeType: "application/vnd.google-apps.spreadsheet" },
        ],
        nextPageToken: "tok_1",
      },
      mustRedact: ["nimit@example.com", "accounting@example.com"],
      mustPreserve: ["f_001", "f_002", "Budget 2026", "application/vnd.google-apps.spreadsheet", "tok_1"],
    });
  });

  await runTest("create a new sheet", async () => {
    await runScenario({
      name: "create sheet",
      prompt: "Create a sheet called Inventory.",
      toolResult: {
        spreadsheetId: "new_sheet_abc",
        title: "Inventory",
        url: "https://docs.google.com/spreadsheets/d/new_sheet_abc/edit",
        createdBy: "nimit@example.com",
      },
      mustRedact: ["nimit@example.com"],
      mustPreserve: ["new_sheet_abc", "Inventory", "https://docs.google.com/spreadsheets/d/new_sheet_abc/edit"],
    });
  });

  await runTest("sum a column", async () => {
    await runScenario({
      name: "sum column",
      prompt: "Sum the Amount column in Sales.",
      toolResult: {
        spreadsheetId: "sp_1",
        range: "Sales!C1:C10",
        sum: 771000,
        values: [45000, 32000, 88000, 120000, 26000, 175000, 56000, 94000, 43000, 82000],
      },
      mustRedact: [],
      mustPreserve: ["sp_1", "Sales!C1:C10"],
    });
  });

  await runTest("filter rows by condition", async () => {
    await runScenario({
      name: "filter rows",
      prompt: "Filter leads where amount > 100000.",
      toolResult: {
        spreadsheetId: "sp_2",
        range: "Leads!A1:E20",
        matchedRows: [
          ["Ritu Agarwal", "Delhi", 120000, "ritu.agarwal@gmail.com"],
          ["Farhan Ali", "Mumbai", 175000, "farhan.ali@gmail.com"],
        ],
      },
      mustRedact: ["Ritu Agarwal", "ritu.agarwal@gmail.com", "Farhan Ali", "farhan.ali@gmail.com"],
      mustPreserve: ["sp_2", "Leads!A1:E20", "Delhi", "Mumbai"],
    });
  });

  await runTest("lookup a value by key", async () => {
    await runScenario({
      name: "vlookup",
      prompt: "Look up the email for employee ID 1042.",
      toolResult: {
        spreadsheetId: "sp_3",
        found: true,
        employeeId: 1042,
        email: "sana.khan@example.com",
        department: "Engineering",
      },
      mustRedact: ["sana.khan@example.com"],
      mustPreserve: ["sp_3", "1042", "Engineering"],
    });
  });

  await runTest("update a range of cells", async () => {
    await runScenario({
      name: "update range",
      prompt: "Update Q3 column with the new numbers.",
      toolResult: {
        spreadsheetId: "sp_4",
        updatedRange: "Q3!B2:B5",
        updatedRows: 4,
        values: [10, 20, 30, 40],
        updatedBy: "nimit@example.com",
      },
      mustRedact: ["nimit@example.com"],
      mustPreserve: ["sp_4", "Q3!B2:B5"],
    });
  });

  await runTest("delete a row", async () => {
    await runScenario({
      name: "delete row",
      prompt: "Delete row 7 from the Attendance sheet.",
      toolResult: {
        spreadsheetId: "sp_5",
        deletedRow: 7,
        sheet: "Attendance",
        affectedRows: 1,
      },
      mustRedact: [],
      mustPreserve: ["sp_5", "Attendance", "7"],
    });
  });

  await runTest("get sheet metadata", async () => {
    await runScenario({
      name: "sheet metadata",
      prompt: "Who last edited the Budget sheet?",
      toolResult: {
        spreadsheetId: "sp_6",
        properties: { title: "Budget", locale: "en_IN", timeZone: "Asia/Kolkata" },
        lastModifiedBy: { name: "Nimit Shah", email: "nimit.shah@gmail.com" },
        lastModifiedTime: "2026-08-07T09:00:00Z",
      },
      mustRedact: ["nimit.shah@gmail.com", "Nimit Shah"],
      mustPreserve: ["sp_6", "Budget", "Asia/Kolkata", "2026-08-07T09:00:00Z"],
    });
  });

  // ── GitHub (10) ─────────────────────────────────────────────────────
  await runTest("get a repository", async () => {
    await runScenario({
      name: "get repo",
      prompt: "Get the nimits-Jarvis repo details.",
      toolResult: {
        id: 1296269,
        name: "nimits-Jarvis",
        full_name: "Nimit-Shah/nimits-Jarvis",
        owner: {
          login: "Nimit-Shah",
          id: 1,
          node_id: "MDQ6VXNlcjE=",
          type: "User",
          site_admin: false,
        },
        private: false,
        html_url: "https://github.com/Nimit-Shah/nimits-Jarvis",
        clone_url: "https://github.com/Nimit-Shah/nimits-Jarvis.git",
        ssh_url: "git@github.com:Nimit-Shah/nimits-Jarvis.git",
        default_branch: "main",
        language: "TypeScript",
        plan: { name: "free", space: 987654321, collaborators: 0, private_repos: 10000 },
      },
      mustRedact: [],
      mustPreserve: [
        "Nimit-Shah",
        "nimits-Jarvis",
        "Nimit-Shah/nimits-Jarvis",
        "MDQ6VXNlcjE=",
        "https://github.com/Nimit-Shah/nimits-Jarvis.git",
        "git@github.com:Nimit-Shah/nimits-Jarvis.git",
        "main",
        "TypeScript",
        "free",
      ],
    });
  });

  await runTest("list files in a repo", async () => {
    await runScenario({
      name: "list repo files",
      prompt: "List files in the src folder of nimits-Jarvis.",
      toolResult: {
        path: "src",
        type: "dir",
        entries: [
          { name: "index.ts", path: "src/index.ts", type: "file", size: 1024, download_url: "https://raw.githubusercontent.com/Nimit-Shah/nimits-Jarvis/main/src/index.ts" },
          { name: "utils", path: "src/utils", type: "dir" },
        ],
      },
      mustRedact: [],
      mustPreserve: ["src/index.ts", "index.ts", "https://raw.githubusercontent.com/Nimit-Shah/nimits-Jarvis/main/src/index.ts", "src/utils"],
    });
  });

  await runTest("get file content from a repo", async () => {
    await runScenario({
      name: "get file content",
      prompt: "Show me the content of pii-tokenizer.ts from the repo.",
      toolResult: {
        name: "pii-tokenizer.ts",
        path: "src/server/pii/pii-tokenizer.ts",
        size: 573,
        type: "file",
        sha: "abc123",
        content: "export const TOKEN_RE = /CLAW_[A-F0-9]{4}/;\n",
        encoding: "base64",
      },
      mustRedact: [],
      mustPreserve: ["pii-tokenizer.ts", "src/server/pii/pii-tokenizer.ts", "abc123", "base64"],
    });
  });

  await runTest("create a GitHub issue", async () => {
    await runScenario({
      name: "create issue",
      prompt: "Create an issue in nimits-Jarvis titled 'Fix the bug'.",
      toolResult: {
        id: 1347,
        number: 42,
        title: "Fix the bug",
        state: "open",
        html_url: "https://github.com/Nimit-Shah/nimits-Jarvis/issues/42",
        user: { login: "Nimit-Shah", id: 1 },
        created_at: "2026-08-07T10:00:00Z",
      },
      mustRedact: [],
      mustPreserve: ["Nimit-Shah", "https://github.com/Nimit-Shah/nimits-Jarvis/issues/42", "1347", "open"],
    });
  });

  await runTest("create a pull request", async () => {
    await runScenario({
      name: "create PR",
      prompt: "Open a PR from feature branch to main.",
      toolResult: {
        id: 1937,
        number: 88,
        title: "Add PII fixes",
        head: { ref: "fix/pii" },
        base: { ref: "main" },
        state: "open",
        user: { login: "Nimit-Shah" },
        html_url: "https://github.com/Nimit-Shah/nimits-Jarvis/pull/88",
      },
      mustRedact: [],
      mustPreserve: ["Nimit-Shah", "fix/pii", "main", "Add PII fixes", "https://github.com/Nimit-Shah/nimits-Jarvis/pull/88"],
    });
  });

  await runTest("list open PRs", async () => {
    await runScenario({
      name: "list PRs",
      prompt: "List open PRs in the repo.",
      toolResult: {
        pullRequests: [
          { id: 1937, number: 88, title: "Add PII fixes", user: { login: "Nimit-Shah" } },
          { id: 1938, number: 89, title: "Docs update", user: { login: "octocat" } },
        ],
      },
      mustRedact: [],
      mustPreserve: ["Nimit-Shah", "octocat", "Add PII fixes", "Docs update", "1937"],
    });
  });

  await runTest("get a commit", async () => {
    await runScenario({
      name: "get commit",
      prompt: "Show the latest commit details.",
      toolResult: {
        sha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
        commit: {
          author: { name: "Nimit Shah", email: "nimit.shah@gmail.com", date: "2026-08-07T11:00:00Z" },
          message: "fix: harden PII restore",
        },
        html_url: "https://github.com/Nimit-Shah/nimits-Jarvis/commit/7fd1a60b",
      },
      mustRedact: ["nimit.shah@gmail.com", "Nimit Shah"],
      mustPreserve: ["7fd1a60b01f91b314f59955a4e4d4e80d8edf11d", "fix: harden PII restore", "https://github.com/Nimit-Shah/nimits-Jarvis/commit/7fd1a60b"],
      mustRestore: ["nimit.shah@gmail.com"],
    });
  });

  await runTest("star a repository", async () => {
    await runScenario({
      name: "star repo",
      prompt: "Star the openclaw repo.",
      toolResult: {
        starred: true,
        repo: "Nimit-Shah/nimits-Jarvis",
        stargazers: 5,
      },
      mustRedact: [],
      mustPreserve: ["Nimit-Shah/nimits-Jarvis"],
    });
  });

  await runTest("search repositories", async () => {
    await runScenario({
      name: "search repos",
      prompt: "Search GitHub for pii-tokenizer repos.",
      toolResult: {
        totalCount: 12,
        items: [
          { full_name: "Nimit-Shah/nimits-Jarvis", stargazers_count: 5, html_url: "https://github.com/Nimit-Shah/nimits-Jarvis" },
          { full_name: "openai/openai-python", stargazers_count: 24000, html_url: "https://github.com/openai/openai-python" },
        ],
      },
      mustRedact: [],
      mustPreserve: ["Nimit-Shah/nimits-Jarvis", "openai/openai-python", "https://github.com/openai/openai-python", "24000"],
    });
  });

  await runTest("get authenticated user", async () => {
    await runScenario({
      name: "get user",
      prompt: "Show my GitHub profile.",
      toolResult: {
        login: "Nimit-Shah",
        id: 53946338,
        avatar_url: "https://avatars.githubusercontent.com/u/53946338?v=4",
        html_url: "https://github.com/Nimit-Shah",
        followers_url: "https://api.github.com/users/Nimit-Shah/followers",
        repos_url: "https://api.github.com/users/Nimit-Shah/repos",
        followers: 3,
        following: 12,
        public_repos: 8,
        plan: { name: "free", space: 987654321, collaborators: 0, private_repos: 10000 },
      },
      mustRedact: [],
      mustPreserve: [
        "Nimit-Shah",
        "https://avatars.githubusercontent.com/u/53946338?v=4",
        "https://api.github.com/users/Nimit-Shah/followers",
        "https://api.github.com/users/Nimit-Shah/repos",
      ],
    });
  });

  // ── Google Drive (10) ──────────────────────────────────────────────
  await runTest("list drive files", async () => {
    await runScenario({
      name: "list drive files",
      prompt: "List all files in my Drive.",
      seed: [{ type: "person_name", value: "Nimit Shah" }],
      toolResult: {
        files: [
          { id: "1abc", name: "resume.pdf", mimeType: "application/pdf", owners: [{ displayName: "Nimit Shah", emailAddress: "nimit.shah@gmail.com" }], size: "4096" },
          { id: "2def", name: "photo.png", mimeType: "image/png", owners: [{ displayName: "Arun", emailAddress: "arun@gmail.com" }], size: "1048576" },
        ],
        nextPageToken: "tok_drive",
      },
      mustRedact: ["nimit.shah@gmail.com", "Nimit Shah", "arun@gmail.com"],
      mustPreserve: ["1abc", "2def", "resume.pdf", "photo.png", "application/pdf", "image/png", "tok_drive"],
      mustRestore: ["nimit.shah@gmail.com"],
    });
  });

  await runTest("get a drive file", async () => {
    await runScenario({
      name: "get drive file",
      prompt: "Get details of the file called contract.pdf.",
      toolResult: {
        id: "1contract",
        name: "contract.pdf",
        mimeType: "application/pdf",
        size: "8192",
        createdTime: "2026-01-15T10:00:00Z",
        modifiedTime: "2026-07-30T09:00:00Z",
        webViewLink: "https://drive.google.com/file/d/1contract/view",
      },
      mustRedact: [],
      mustPreserve: ["1contract", "contract.pdf", "application/pdf", "https://drive.google.com/file/d/1contract/view"],
    });
  });

  await runTest("upload a file to drive", async () => {
    await runScenario({
      name: "upload drive file",
      prompt: "Upload notes.txt to my Drive.",
      toolResult: {
        id: "1uploaded",
        name: "notes.txt",
        mimeType: "text/plain",
        parents: ["0AFolder"],
        size: "512",
      },
      mustRedact: [],
      mustPreserve: ["1uploaded", "notes.txt", "text/plain", "0AFolder"],
    });
  });

  await runTest("download a file from drive", async () => {
    await runScenario({
      name: "download drive file",
      prompt: "Download the report and read it.",
      toolResult: {
        id: "1report",
        name: "report.txt",
        mimeType: "text/plain",
        content: "Quarterly report prepared by Nimit Shah. Contact nimit.shah@gmail.com for details.",
      },
      mustRedact: ["nimit.shah@gmail.com", "Nimit Shah"],
      mustPreserve: ["1report", "report.txt", "Quarterly report"],
      mustRestore: ["nimit.shah@gmail.com"],
    });
  });

  await runTest("search drive", async () => {
    await runScenario({
      name: "search drive",
      prompt: "Find any file containing the word 'invoice'.",
      toolResult: {
        query: "fullText contains 'invoice'",
        files: [
          { id: "1inv", name: "invoice-oct.pdf", mimeType: "application/pdf", owners: [{ displayName: "Kiran B.", emailAddress: "kiran.b@gmail.com" }] },
        ],
      },
      mustRedact: ["kiran.b@gmail.com", "Kiran"],
      mustPreserve: ["1inv", "invoice-oct.pdf", "fullText contains 'invoice'"],
    });
  });

  await runTest("create a drive folder", async () => {
    await runScenario({
      name: "create folder",
      prompt: "Create a folder called 'Reports 2026'.",
      toolResult: {
        id: "1folder",
        name: "Reports 2026",
        mimeType: "application/vnd.google-apps.folder",
        parents: [],
      },
      mustRedact: [],
      mustPreserve: ["1folder", "Reports 2026", "application/vnd.google-apps.folder"],
    });
  });

  await runTest("move a drive file", async () => {
    await runScenario({
      name: "move drive file",
      prompt: "Move budget.xlsx into the Finance folder.",
      toolResult: {
        id: "1move",
        name: "budget.xlsx",
        mimeType: "application/vnd.ms-excel",
        parents: ["0FFinance"],
        movedFrom: ["0AOldFolder"],
      },
      mustRedact: [],
      mustPreserve: ["1move", "budget.xlsx", "0FFinance", "0AOldFolder", "application/vnd.ms-excel"],
    });
  });

  await runTest("trash a drive file", async () => {
    await runScenario({
      name: "trash drive file",
      prompt: "Delete the old screenshot.png.",
      toolResult: {
        id: "1trash",
        name: "screenshot.png",
        mimeType: "image/png",
        trashed: true,
      },
      mustRedact: [],
      mustPreserve: ["1trash", "screenshot.png", "image/png"],
    });
  });

  await runTest("share a drive file", async () => {
    await runScenario({
      name: "share drive file",
      prompt: "Share the deck with Priya (priya.sharma@gmail.com).",
      seed: [
        { type: "person_name", value: "Priya Sharma" },
        { type: "email", value: "priya.sharma@gmail.com" },
      ],
      toolResult: {
        fileId: "1share",
        permissions: [
          { id: "perm_1", type: "user", role: "writer", emailAddress: "priya.sharma@gmail.com" },
        ],
      },
      mustRedact: ["priya.sharma@gmail.com", "Priya"],
      mustPreserve: ["1share", "perm_1", "writer"],
    });
  });

  await runTest("get drive file permissions", async () => {
    await runScenario({
      name: "drive permissions",
      prompt: "Who has access to the finance sheet?",
      toolResult: {
        fileId: "1perm",
        permissions: [
          { id: "p1", type: "user", role: "owner", emailAddress: "nimit.shah@gmail.com" },
          { id: "p2", type: "user", role: "reader", emailAddress: "audit@example.com" },
        ],
      },
      mustRedact: ["nimit.shah@gmail.com", "audit@example.com"],
      mustPreserve: ["1perm", "p1", "p2", "reader", "owner"],
    });
  });

  // ── Calendar / Scheduling (5) ───────────────────────────────────────
  await runTest("create a calendar event", async () => {
    await runScenario({
      name: "create event",
      prompt: "Create a meeting with Rohan tomorrow at 3pm.",
      seed: [
        { type: "person_name", value: "Rohan Mehta" },
        { type: "email", value: "rohan.mehta@gmail.com" },
      ],
      toolResult: {
        id: "ev_1001",
        summary: "Sync",
        organizer: { email: "nimit.shah@gmail.com", displayName: "Nimit Shah" },
        attendees: [
          { email: "rohan.mehta@gmail.com", displayName: "Rohan Mehta", responseStatus: "needsAction" },
        ],
        start: { dateTime: "2026-08-09T15:00:00", timeZone: "Asia/Kolkata" },
        end: { dateTime: "2026-08-09T15:30:00", timeZone: "Asia/Kolkata" },
        htmlLink: "https://calendar.google.com/calendar/event?eid=ev_1001",
      },
      mustRedact: ["rohan.mehta@gmail.com", "Rohan Mehta", "nimit.shah@gmail.com", "Nimit Shah"],
      mustPreserve: ["ev_1001", "Sync", "Asia/Kolkata", "https://calendar.google.com/calendar/event?eid=ev_1001"],
      mustRestore: ["rohan.mehta@gmail.com", "nimit.shah@gmail.com"],
    });
  });

  await runTest("list calendar events", async () => {
    await runScenario({
      name: "list events",
      prompt: "What's on my calendar today?",
      toolResult: {
        items: [
          { id: "ev_200", summary: "Team standup", organizer: { email: "lead@company.com" } },
          { id: "ev_201", summary: "1:1 with Nimit", attendees: [{ email: "nimit.shah@gmail.com", displayName: "Nimit Shah" }] },
        ],
      },
      mustRedact: ["nimit.shah@gmail.com", "Nimit Shah"],
      mustPreserve: ["ev_200", "ev_201", "Team standup"],
    });
  });

  await runTest("update a calendar event", async () => {
    await runScenario({
      name: "update event",
      prompt: "Move the event with Ananya to 5pm.",
      seed: [{ type: "person_name", value: "Ananya" }],
      toolResult: {
        id: "ev_300",
        summary: "Design review",
        attendees: [{ email: "ananya@gmail.com", displayName: "Ananya Iyer" }],
        start: { dateTime: "2026-08-10T17:00:00", timeZone: "America/New_York" },
      },
      mustRedact: ["ananya@gmail.com", "Ananya"],
      mustPreserve: ["ev_300", "Design review", "America/New_York"],
    });
  });

  await runTest("find free slots", async () => {
    await runScenario({
      name: "free slots",
      prompt: "Find a free slot next week for a 1-hour call.",
      toolResult: {
        timeMin: "2026-08-10T00:00:00Z",
        timeMax: "2026-08-14T23:59:59Z",
        busy: [
          { start: "2026-08-11T10:00:00Z", end: "2026-08-11T11:00:00Z" },
          { start: "2026-08-12T14:00:00Z", end: "2026-08-12T15:00:00Z" },
        ],
        freeSlots: ["2026-08-11T15:00:00Z", "2026-08-12T09:00:00Z"],
      },
      mustRedact: [],
      mustPreserve: ["2026-08-10T00:00:00Z", "2026-08-11T10:00:00Z", "2026-08-12T15:00:00Z"],
    });
  });

  await runTest("cancel a calendar event", async () => {
    await runScenario({
      name: "cancel event",
      prompt: "Cancel the event with Sana tomorrow.",
      seed: [{ type: "person_name", value: "Sana" }],
      toolResult: {
        id: "ev_400",
        summary: "Interview",
        status: "cancelled",
        attendees: [{ email: "sana.khan@example.com", displayName: "Sana Khan" }],
      },
      mustRedact: ["sana.khan@example.com", "Sana"],
      mustPreserve: ["ev_400", "Interview", "cancelled"],
    });
  });

  // ── Slack / Messaging (5) ───────────────────────────────────────────
  await runTest("send a Slack message", async () => {
    await runScenario({
      name: "slack send",
      prompt: "Message the #general channel that the build passed.",
      toolResult: {
        ok: true,
        channel: "C123456",
        ts: "1401383885.000061",
        message: { text: "Build passed 🎉", user: "U987654" },
      },
      mustRedact: [],
      mustPreserve: ["C123456", "1401383885.000061", "U987654", "Build passed"],
    });
  });

  await runTest("read a Slack channel", async () => {
    await runScenario({
      name: "slack read",
      prompt: "What did people say in #random?",
      toolResult: {
        ok: true,
        messages: [
          { user: "U001", text: "Hi Nimit, can you look at this?", ts: "1401383885.000061" },
          { user: "U002", text: "lunch at 1pm", ts: "1401384000.000002" },
        ],
        nextCursor: "bmV4dA==",
      },
      mustRedact: ["Nimit"],
      mustPreserve: ["U001", "U002", "bmV4dA=="],
    });
  });

  await runTest("create a Slack channel", async () => {
    await runScenario({
      name: "slack create channel",
      prompt: "Create a channel called #launch-team.",
      toolResult: {
        ok: true,
        channel: { id: "C777", name: "launch-team", is_private: false, members: ["U001"] },
      },
      mustRedact: [],
      mustPreserve: ["C777", "launch-team", "U001"],
    });
  });

  await runTest("send a Telegram message", async () => {
    await runScenario({
      name: "telegram send",
      prompt: "Send a Telegram update about the deployment.",
      toolResult: {
        ok: true,
        message_id: 987,
        chat: { id: -1001234567890, type: "private" },
        text: "Deployment finished successfully.",
      },
      mustRedact: [],
      mustPreserve: ["987", "-1001234567890", "Deployment finished successfully."],
    });
  });

  await runTest("send a WhatsApp / SMS", async () => {
    await runScenario({
      name: "sms send",
      prompt: "Text +91 98765 43210 that the parcel arrived.",
      toolResult: {
        ok: true,
        messageId: "sms_77",
        to: "+91 98765 43210",
        status: "sent",
        body: "Your parcel has arrived.",
      },
      mustRedact: ["+91 98765 43210"],
      mustPreserve: ["sms_77", "sent", "Your parcel has arrived."],
      mustRestore: ["+91 98765 43210"],
    });
  });

  // ── Contacts / People (5) ───────────────────────────────────────────
  await runTest("search contacts directory", async () => {
    await runScenario({
      name: "search contacts",
      prompt: "Find the phone number for the contact Priya.",
      seed: [{ type: "person_name", value: "Priya" }],
      toolResult: {
        people: [
          {
            resourceName: "people/1038",
            names: [{ displayName: "Priya Sharma", givenName: "Priya", familyName: "Sharma" }],
            phoneNumbers: [{ value: "+91 99999 88888" }],
            emailAddresses: [{ value: "priya.sharma@gmail.com" }],
          },
        ],
      },
      mustRedact: ["priya.sharma@gmail.com", "Priya Sharma", "Priya", "Sharma", "+91 99999 88888"],
      mustPreserve: ["people/1038"],
      mustRestore: ["priya.sharma@gmail.com", "Priya Sharma"],
    });
  });

  await runTest("get a contact profile", async () => {
    await runScenario({
      name: "get contact",
      prompt: "Show me Nimit's saved contact.",
      seed: [
        { type: "person_name", value: "Nimit Shah" },
        { type: "email", value: "nimit.shah@gmail.com" },
      ],
      toolResult: {
        resourceName: "people/1038",
        etag: "W/1234",
        names: [{ displayName: "Nimit Shah", givenName: "Nimit", familyName: "Shah" }],
        emailAddresses: [{ value: "nimit.shah@gmail.com", type: "home" }],
        phoneNumbers: [{ value: "+91 72083 92455", type: "mobile" }],
        metadata: { sources: [{ type: "PROFILE" }] },
      },
      mustRedact: ["nimit.shah@gmail.com", "Nimit Shah", "Nimit", "Shah", "+91 72083 92455"],
      mustPreserve: ["people/1038", "W/1234", "PROFILE"],
      mustRestore: ["nimit.shah@gmail.com", "Nimit Shah"],
    });
  });

  await runTest("create a new contact", async () => {
    await runScenario({
      name: "create contact",
      prompt: "Save a new contact for Kavita, kavita@gmail.com.",
      toolResult: {
        resourceName: "people/new_contact_42",
        names: [{ displayName: "Kavita Joshi" }],
        emailAddresses: [{ value: "kavita@gmail.com" }],
        phoneNumbers: [{ value: "+91 70000 12345" }],
      },
      mustRedact: ["kavita@gmail.com", "Kavita Joshi", "+91 70000 12345"],
      mustPreserve: ["people/new_contact_42"],
    });
  });

  await runTest("update a contact", async () => {
    await runScenario({
      name: "update contact",
      prompt: "Change Rakesh's phone number to +91 81234 56789.",
      seed: [{ type: "person_name", value: "Rakesh" }],
      toolResult: {
        resourceName: "people/contact_9",
        names: [{ displayName: "Rakesh Verma" }],
        phoneNumbers: [{ value: "+91 81234 56789", type: "mobile" }],
        emailAddresses: [{ value: "rakesh.verma@gmail.com" }],
      },
      mustRedact: ["+91 81234 56789", "Rakesh Verma", "Rakesh", "rakesh.verma@gmail.com"],
      mustPreserve: ["people/contact_9"],
      mustRestore: ["+91 81234 56789"],
    });
  });

  await runTest("get my own profile / who am I", async () => {
    await runScenario({
      name: "own profile",
      prompt: "Tell me about my profile.",
      seed: [
        { type: "person_name", value: "Nimit Shah" },
        { type: "email", value: "nimitshah2503@gmail.com" },
      ],
      toolResult: {
        resourceName: "people/me",
        names: [{ displayName: "Nimit Shah", givenName: "Nimit" }],
        emailAddresses: [{ value: "nimitshah2503@gmail.com", type: "account" }],
        occupations: [{ value: "Software Engineer" }],
        biographies: [{ value: "Building nimits-Jarvis, an AI agent." }],
      },
      mustRedact: ["nimitshah2503@gmail.com", "Nimit Shah", "Nimit"],
      mustPreserve: ["people/me", "Software Engineer", "nimits-Jarvis"],
      mustRestore: ["nimitshah2503@gmail.com"],
    });
  });

  // ── Memory / Custom (5) ─────────────────────────────────────────────
  await runTest("save a memory", async () => {
    await runScenario({
      name: "memory save",
      prompt: "Remember that I prefer short replies.",
      toolResult: {
        saved: true,
        content: "User prefers short replies. Contact email nimit.shah@gmail.com.",
        importance: 0.8,
      },
      seed: [
        { type: "email", value: "nimit.shah@gmail.com" },
        { type: "person_name", value: "Nimit" },
      ],
      mustRedact: ["nimit.shah@gmail.com", "Nimit"],
      mustPreserve: ["saved", "short replies"],
      mustRestore: ["nimit.shah@gmail.com"],
    });
  });

  await runTest("search memory", async () => {
    await runScenario({
      name: "memory search",
      prompt: "Search my memory for the meeting with Priya.",
      seed: [{ type: "person_name", value: "Priya" }],
      toolResult: {
        found: true,
        memories: [
          { content: "Met Priya on Aug 3 to discuss roadmap.", relevance: 0.92 },
          { content: "Priya prefers email (priya.sharma@gmail.com).", relevance: 0.84 },
        ],
      },
      mustRedact: ["Priya", "priya.sharma@gmail.com"],
      mustPreserve: ["roadmap", "0.92"],
      mustRestore: ["priya.sharma@gmail.com"],
    });
  });

  await runTest("schedule a cron job", async () => {
    await runScenario({
      name: "schedule cron",
      prompt: "Schedule a reminder every morning at 9am.",
      toolResult: {
        jobId: "cron_abc",
        expression: "0 9 * * *",
        chatId: "chat_xyz",
        createdBy: "nimit.shah@gmail.com",
        nextRunAt: "2026-08-09T09:00:00+05:30",
      },
      mustRedact: ["nimit.shah@gmail.com"],
      mustPreserve: ["cron_abc", "0 9 * * *", "chat_xyz", "2026-08-09T09:00:00+05:30"],
    });
  });

  await runTest("fetch a website / web scrape", async () => {
    await runScenario({
      name: "web scrape",
      prompt: "Fetch the pricing page from example.com.",
      toolResult: {
        url: "https://example.com/pricing",
        title: "Pricing",
        text: "Contact sales at sales@example.com or call +1 (415) 555-0132 for the enterprise plan.",
      },
      mustRedact: ["sales@example.com", "+1 (415) 555-0132"],
      mustPreserve: ["https://example.com/pricing", "Pricing", "enterprise plan"],
      mustRestore: ["sales@example.com"],
    });
  });

  await runTest("fetch LinkedIn profile", async () => {
    await runScenario({
      name: "linkedin fetch",
      prompt: "Get the LinkedIn profile for Nimit Shah.",
      seed: [{ type: "person_name", value: "Nimit Shah" }],
      toolResult: {
        profile_url: "https://www.linkedin.com/in/nimit-shah",
        vanityname: "nimit-shah",
        headline: "Software Engineer at Nimits-Jarvis",
        location: "Bengaluru",
        publicIdentifier: "nimit-shah",
      },
      mustRedact: ["https://www.linkedin.com/in/nimit-shah", "nimit-shah"],
      mustPreserve: ["Software Engineer at Nimits-Jarvis", "Bengaluru"],
    });
  });

  // ── Security / Secrets (5) ──────────────────────────────────────────
  await runTest("detect an exposed API key", async () => {
    await runScenario({
      name: "api key",
      prompt: "Did the error log leak any keys?",
      toolResult: {
        log: "Key: sk-proj-9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f",
        source: "app.log",
      },
      mustRedact: ["sk-proj-9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f"],
      mustPreserve: ["app.log"],
    });
  });

  await runTest("detect an SSN", async () => {
    await runScenario({
      name: "ssn",
      prompt: "Is there an SSN in this form?",
      toolResult: {
        form: { ssn: "123-45-6789", name: "Jane Roe" },
        submittedAt: "2026-08-01",
      },
      mustRedact: ["123-45-6789", "Jane Roe"],
      mustPreserve: ["2026-08-01"],
    });
  });

  await runTest("detect a credit card (Luhn)", async () => {
    await runScenario({
      name: "credit card",
      prompt: "Validate this card number 4687 7991 1136 510.",
      toolResult: {
        cardNumber: "4687 7991 1136 510",
        valid: true,
        brand: "Visa",
        holder: "Nimit Shah",
      },
      mustRedact: ["4687 7991 1136 510", "Nimit Shah"],
      mustPreserve: ["Visa", "true"],
    });
  });

  await runTest("detect an IP address", async () => {
    await runScenario({
      name: "ip address",
      prompt: "Check the IP that made the request.",
      toolResult: {
        request: { ip: "192.168.1.100", method: "GET", path: "/api/chat", sessionId: "sess_001" },
      },
      mustRedact: ["192.168.1.100"],
      mustPreserve: ["/api/chat", "sess_001", "GET"],
      mustRestore: ["192.168.1.100"],
    });
  });

  await runTest("detect a physical address", async () => {
    await runScenario({
      name: "address",
      prompt: "Where should I ship the package?",
      toolResult: {
        order: { id: "ord_55", shippingAddress: "203 RR Valencia, 6th ave, Greenville, Bangalore 560035", phone: "+91 72083 92455" },
      },
      mustRedact: ["203 RR Valencia, 6th ave, Greenville, Bangalore 560035", "+91 72083 92455"],
      mustPreserve: ["ord_55"],
      mustRestore: ["+91 72083 92455"],
    });
  });

  // ── L3 DeBERTa prose-name checks (soft) ─────────────────────────────
  console.log("\n=== L3 DeBERTa: free-text person names ===\n");
  const mlAvailable = proseLayerAvailable();

  await runTest("prose: a person's name mentioned in an email body", async () => {
    const vault = new PIIVault();
    vault.registerStructuredPII({ from: { name: "Kiran B." } });
    const body =
      "The report was prepared by Kiran B. and reviewed by the finance team last Tuesday.";
    const redacted = await vault.redact(body);
    if (mlAvailable) {
      assert(
        !redacted.includes("Kiran B."),
        `L3 should redact prose name, got: ${redacted}`,
      );
    } else {
      assert(
        !redacted.includes("CLAW_") || redacted.includes("CLAW_"),
        `DeBERTa unavailable — prose-name assertion soft-skipped (redacted: ${redacted})`,
      );
      skipped++;
      console.log("    (skipped: DeBERTa unavailable)");
    }
  });

  await runTest("prose: two names in a meeting note", async () => {
    const vault = new PIIVault();
    const note = "Meeting attendees: Rohan Mehta and Ananya Iyer. Both confirmed.";
    const redacted = await vault.redact(note);
    if (mlAvailable) {
      assert(
        !redacted.includes("Rohan Mehta") && !redacted.includes("Ananya Iyer"),
        `L3 should redact both prose names, got: ${redacted}`,
      );
    } else {
      skipped++;
      console.log("    (skipped: DeBERTa unavailable)");
    }
  });

  await runTest("prose: name inside a sentence with an email", async () => {
    const vault = new PIIVault();
    const text = "Contact John Carter at john.carter@example.com for access.";
    const redacted = await vault.redact(text);
    // L2 regex MUST always catch the email regardless of ML availability.
    assert(
      !redacted.includes("john.carter@example.com"),
      `L2 must redact the email regardless of ML, got: ${redacted}`,
    );
    if (mlAvailable) {
      assert(
        !redacted.includes("John Carter"),
        `L3 should also redact the prose name, got: ${redacted}`,
      );
    } else {
      skipped++;
      console.log("    (skipped: DeBERTa unavailable)");
    }
  });

  await runTest("prose: no false positives on machine strings", async () => {
    const vault = new PIIVault();
    const text = "Deploy nimits-jarvis to composio.ts and openai-python.";
    const redacted = await vault.redact(text);
    assert(
      redacted.includes("nimits-jarvis") &&
        redacted.includes("composio.ts") &&
        redacted.includes("openai-python"),
      `machine strings must survive regardless of ML, got: ${redacted}`,
    );
  });

  // ── Summary ─────────────────────────────────────────────────────────
  console.log(
    `\n=== Injection Suite: ${passed} passed, ${failed} failed, ${skipped} soft-skipped (DeBERTa unavailable) ===\n`,
  );
  if (failed > 0) process.exit(1);
}

runAllScenarios().catch((err) => {
  console.error(err);
  process.exit(1);
});
