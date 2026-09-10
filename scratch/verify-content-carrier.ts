/**
 * Phase 0/2 — content-carrier floor (docs/TOKEN_EFFICIENCY.md §4 addendum B).
 *
 * Deterministic reproduction of the degraded-context post failure:
 *   row0  user        "read the changelog"
 *   row1  assistant   fs_read  → 70 KB single-string content  (CARRIER)
 *   row2  user        "list the docs folder"
 *   row3  assistant   fs_list  → array of small records        (non-carrier)
 *   row4  user        "search memories"
 *   row5  assistant   memory_search → small records            (non-carrier)
 *   row6  user        "read agents.md"
 *   row7  assistant   fs_read  → 3.5 KB content                (CARRIER, small)
 *   row8  user        "ok"
 *   (current user turn "post it on linkedin" is appended by buildContext)
 *
 * lastToolRowIndex = 7 → gather (row1) age = 6 → SUMMARY tier without B.
 *
 * Run BEFORE the fix: expect $summarized on the 70 KB carrier (the failure).
 * Run AFTER  the fix: expect a 4,000-char head/tail excerpt whose serialized
 * marker contains the literal callId — content stays composable.
 */
import { reconstructMessages } from "../src/server/api/routers/nimits-jarvis/agent/context/build-context";

function bigChangelog(): string {
  const parts: string[] = [];
  parts.push(
    "HEADMARKER: Changelog\n\nAll notable changes to this project will be documented in this file.\n\n",
  );
  for (let i = 0; i < 240; i++) {
    parts.push(
      `## [1.${i}.0] - 2026-08-${(i % 28) + 1}\n\n### Added\n\n- MIDMARKER-${i}: implements a subsystem of the agent runtime with detailed notes about token budgeting, cache prefixes, and the pii layers. Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.\n\n`,
    );
  }
  parts.push(
    "\nTAILMARKER: legacy migration notes, acknowledgements, and the final section at the very end of the document.\n",
  );
  return parts.join("");
}

const rows: Array<{ role: string; content: unknown }> = [
  { role: "user", content: [{ type: "text", text: "read the changelog" }] },
  {
    role: "assistant",
    content: [
      {
        type: "dynamic-tool",
        toolCallId: "call_gather",
        toolName: "fs_read",
        state: "output-available",
        input: { path: "~/x/CHANGELOG.md", maxBytes: 65536 },
        output: {
          path: "/Users/op/x/CHANGELOG.md",
          content: bigChangelog(),
          sizeBytes: 0,
          truncated: false,
          bytesReturned: 0,
        },
      },
    ],
  },
  { role: "user", content: [{ type: "text", text: "list the docs folder" }] },
  {
    role: "assistant",
    content: [
      {
        type: "dynamic-tool",
        toolCallId: "call_list",
        toolName: "fs_list",
        state: "output-available",
        input: { path: "~/x/docs", depth: 1 },
        output: {
          path: "/Users/op/x/docs",
          entries: Array.from({ length: 30 }, (_, i) => ({
            name: `doc-${i}.md`,
            type: "file",
            sizeBytes: 900 + i,
          })),
          totalSeen: 30,
          truncated: false,
        },
      },
    ],
  },
  { role: "user", content: [{ type: "text", text: "search memories" }] },
  {
    role: "assistant",
    content: [
      {
        type: "dynamic-tool",
        toolCallId: "call_mem",
        toolName: "memory_search",
        state: "output-available",
        input: { query: "token work" },
        output: {
          found: true,
          memories: [
            {
              content: "USER PREFERENCE: prefers concise answers",
              importance: 0.85,
            },
            {
              content: "PROJECT: token efficiency plan landed",
              importance: 0.7,
            },
          ],
        },
      },
    ],
  },
  { role: "user", content: [{ type: "text", text: "read agents.md" }] },
  {
    role: "assistant",
    content: [
      {
        type: "dynamic-tool",
        toolCallId: "call_small_read",
        toolName: "fs_read",
        state: "output-available",
        input: { path: "~/x/AGENTS.md" },
        output: {
          path: "/Users/op/x/AGENTS.md",
          content:
            "SMALLMARKER: " + "Agent conventions. ".repeat(180) + " Ends here.",
          sizeBytes: 3500,
          truncated: false,
        },
      },
    ],
  },
  { role: "user", content: [{ type: "text", text: "ok" }] },
];

function findToolOutput(
  reconstructed: ReturnType<typeof reconstructMessages>,
  callId: string,
): { type: string; value: unknown } | undefined {
  for (const msg of reconstructed) {
    if (msg.role !== "tool") continue;
    for (const part of msg.content) {
      if (part.toolCallId === callId) return part.output;
    }
  }
  return undefined;
}

function main() {
  const out = reconstructMessages(rows);

  const gather = findToolOutput(out, "call_gather")!;
  const gatherStr = JSON.stringify(gather);
  console.log(`── gather (70 KB carrier, age 6) ──`);
  console.log(`type=${gather.type} size=${gatherStr.length}`);
  console.log(`head: ${gatherStr.slice(0, 220)}`);

  const small = findToolOutput(out, "call_small_read")!;
  const smallStr = JSON.stringify(small);
  console.log(`\n── small read (3.5 KB carrier, age 0) ──`);
  console.log(`type=${small.type} size=${smallStr.length}`);

  const list = findToolOutput(out, "call_list")!;
  const listStr = JSON.stringify(list);
  console.log(`\n── fs_list (non-carrier array, age 4) ──`);
  console.log(`type=${list.type} size=${listStr.length}`);

  const results: Array<[string, boolean]> = [];
  const summarized = gatherStr.includes("$summarized");
  // The callId must be reachable by the model in WHATEVER form survives:
  //   pre-B  → {"$summarized":{"callId":"call_gather",...}}
  //   post-B → …[+N of M chars omitted — read_tool_result(callId="call_gather") …]…
  const callIdInMarker =
    /"callId":"call_gather"/.test(gatherStr) ||
    gatherStr.includes('read_tool_result(callId=\\"call_gather\\")') ||
    gatherStr.includes('read_tool_result(callId="call_gather")');

  // ── pre-B failure state (documented; flips after the fix) ──
  results.push(["pre-B state: carrier was $summarized", summarized]);
  // ── post-B invariants (the actual assertions) ──
  results.push([
    "callId reachable in the surviving marker (either form)",
    callIdInMarker,
  ]);

  // Post-fix expectations (only assertable after B lands):
  const excerpted =
    !summarized &&
    gatherStr.includes("HEADMARKER") &&
    gatherStr.includes("TAILMARKER") &&
    gatherStr.includes("read_tool_result");
  const middleOmitted = !gatherStr.includes("MIDMARKER-120");
  results.push(["[post-B] carrier excerpted head+tail with marker", excerpted]);
  results.push(["[post-B] middle omitted", middleOmitted]);
  results.push([
    "[post-B] small read kept full at age 0",
    smallStr.includes("SMALLMARKER") &&
      !smallStr.includes("$summarized") &&
      smallStr.length > 3000,
  ]);

  for (const [name, ok] of results) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) process.exitCode = 1;
  }
}

main();
