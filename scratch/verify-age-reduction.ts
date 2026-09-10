/**
 * Phase 4 verification — age-decay reduction, search collapse, boilerplate
 * strip, and marker validity through the REAL reconstructMessages path.
 */
import { reconstructMessages } from "../src/server/api/routers/nimits-jarvis/agent/context/build-context";

function bigRecord(i: number) {
  return {
    id: `rec_${i}`,
    name: `Record Number ${i}`,
    email: `user${i}@example.com`,
    logId: "lg_123",
    successful: true,
    error: null,
    nested: { a: Array.from({ length: 20 }, (_, j) => `x${i}_${j}`) },
  };
}

function multiExecRow(callId: string, records: number): { role: string; content: unknown } {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "executing" },
      {
        type: "dynamic-tool",
        toolCallId: callId,
        toolName: "COMPOSIO_MULTI_EXECUTE_TOOL",
        state: "output-available",
        input: { tools: [{ tool_slug: "GITHUB_GET_A_REPOSITORY", arguments: {} }] },
        output: Array.from({ length: records }, (_, i) => bigRecord(i)),
      },
    ],
  };
}

const searchRow = {
  role: "assistant" as const,
  content: [
    {
      type: "dynamic-tool",
      toolCallId: "tc_search",
      toolName: "COMPOSIO_SEARCH_TOOLS",
      state: "output-available",
      input: { queries: [{ use_case: "get a github repo" }] },
      output: {
        data: {
          error: null,
          results: [
            {
              index: 1,
              plan_id: "p1",
              toolkits: ["github"],
              use_case: "get a github repo",
              execution_guidance:
                "available inline above - process it directly in your next message. Only use workbench if you need complex scripting...".repeat(3),
              primary_tool_slugs: "GITHUB_GET_A_REPOSITORY,GITHUB_LIST_COMMITS",
              related_tool_slugs: "GITHUB_SEARCH_CODE",
            },
            {
              index: 2,
              plan_id: "p2",
              toolkits: ["github"],
              use_case: "never selected",
              execution_guidance: "guidance",
              primary_tool_slugs: "GITHUB_DOES_NOT_EXIST",
              related_tool_slugs: "",
            },
          ],
        },
      },
    },
  ],
};

const fixture = [
  { role: "user", content: '["hello"]' },
  searchRow,
  multiExecRow("tc_old3", 40),
  multiExecRow("tc_age2", 30),
  multiExecRow("tc_age1", 25),
  multiExecRow("tc_age0", 20),
  { role: "user", content: '["what do we have"]' },
];

function main() {
  const out = reconstructMessages(fixture as never);
  const toolMsgs = out.filter((m) => m.role === "tool");
  const sizes: Record<string, number> = {};
  for (const t of toolMsgs) {
    for (const part of t.content) {
      const key = part.toolCallId;
      sizes[key] = JSON.stringify(part.output).length;
      console.log(`— ${key} (${String(part.toolName)}) output type=${part.output.type} size=${sizes[key]}`);
    }
  }

  const j = (id: string) =>
    toolMsgs.flatMap((m) => m.content).find((p) => p.toolCallId === id)!.output;

  const results: Array<[string, boolean]> = [];

  // 1. spent search collapsed to stub (selected slug invoked later)
  const search = j("tc_search") as { type: string; value: unknown };
  const searchVal = search.value as Record<string, unknown>;
  results.push(["search collapsed", searchVal.searched === "get a github repo" && searchVal.selected === "GITHUB_GET_A_REPOSITORY"]);
  console.log("  search stub:", JSON.stringify(searchVal));

  // 2. the collapsed stub replaced the schema dump entirely (no guidance left)
  const searchRaw = JSON.stringify(searchVal);
  results.push(["stub has no guidance text", !searchRaw.includes("execution_guidance") && !searchRaw.includes("available inline above")]);

  // 3. boilerplate stripped on recent results
  const age0raw = JSON.stringify(j("tc_age0"));
  results.push(["age0 boilerplate gone", !age0raw.includes("logId") && !age0raw.includes('"successful":true') && !age0raw.includes('"error":null')]);

  // 4. age0/age1 full: record count intact
  const age0 = j("tc_age0") as any;
  const age1 = j("tc_age1") as any;
  results.push(["age0 full (20 records)", Array.isArray(age0.value) && age0.value.length === 20]);
  results.push(["age1 full (25 records)", Array.isArray(age1.value) && age1.value.length === 25]);

  // 5. age2 reduced ≤4000 with valid marker
  const age2 = j("tc_age2") as any;
  const age2len = parseInt(String(sizes["tc_age2"]), 10);
  results.push(["age2 ≤4000", Array.isArray(age2.value) && age2len <= 4000]);
  const marker = Array.isArray(age2.value) ? age2.value.at(-1) : null;
  results.push(["age2 marker present", !!marker && typeof marker === "object" && "$omitted" in (marker as Record<string, unknown>)]);
  results.push(["age2 marker offset==kept", marker && (marker as any).$omitted.offset === 30 - 0 - Number((marker as any).$omitted.count)]);
  if (marker) console.log("  age2 marker:", JSON.stringify((marker as any).$omitted));

  // 6. age3 reduced (older step)
  const age3 = j("tc_old3") as any;
  results.push(["age3 ≤4000", Array.isArray(age3.value) && numbersum(sizes["tc_old3"]) <= 4000]);

  for (const [name, ok] of results) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) process.exitCode = 1;
  }
}

function numbersum(n: number) {
  return typeof n === "number" ? n : 99999;
}

main();