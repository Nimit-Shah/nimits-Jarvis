/**
 * Structure-aware tool-result reduction (docs/TOKEN_EFFICIENCY.md §4).
 *
 * Never cuts data — everything removed is reachable via read_tool_result by
 * callId. Reduction is by AGE, applied at READ time (message reconstruction):
 *
 *   age 0-1  full payload          (the step where it matters)
 *   age 2-4  first whole records + explicit marker, ≤ 4,000 chars
 *   age ≥5   one-line summary + callId
 *
 * Arrays: keep whole records, never split an object. Non-arrays: head/tail
 * with a byte-accurate marker (text form), never mid-object JSON.
 */

import type { ToolResultOutput, JsonValue } from "../types";

/** How far back (in assistant steps) a tool result is before reduction kicks in. */
export function reductionBudgetForAge(age: number): number | "summary" {
  if (age < 2) return Number.POSITIVE_INFINITY;
  if (age < 5) return 4_000;
  return "summary";
}

// ── §B content-carrier floor ─────────────────────────────────────────────────
// Classified by SHAPE, not tool name: a payload carrying any single string
// ≥ CONTENT_CARRIER_MIN_CHARS is holding content someone may need verbatim
// (file reads, fetched documents, message bodies). Names go stale —
// GMAIL_GET_MESSAGE, NOTION_GET_PAGE, whatever ships next month — the shape
// does not. Carriers never collapse to a one-line summary; they floor at the
// 4,000-char head/tail excerpt (~1.1k tokens) so a final "post it / send it"
// turn can still compose from real content instead of fabricating it.
const CONTENT_CARRIER_MIN_CHARS = 2_000;
const CONTENT_CARRIER_DEPTH = 3;

function deepFindStrings(value: unknown, depth: number, out: string[]): void {
  if (depth < 0) return;
  if (typeof value === "string") {
    if (value.length >= CONTENT_CARRIER_MIN_CHARS) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) deepFindStrings(v, depth - 1, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) deepFindStrings(v, depth - 1, out);
  }
}

export function isContentCarrier(payload: unknown): boolean {
  const found: string[] = [];
  deepFindStrings(payload, CONTENT_CARRIER_DEPTH, found);
  return found.length > 0;
}

function sizeChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function omissionMarker(
  callId: string,
  toolName: string,
  offset: number,
  count: number,
) {
  return {
    $omitted: {
      count,
      callId,
      toolName,
      offset,
      hint: `read_tool_result(callId="${callId}", offset=${offset})`,
    },
  };
}

function summaryEntry(callId: string, toolName: string, payload: unknown) {
  const items = Array.isArray(payload) ? payload.length : undefined;
  return {
    $summarized: {
      callId,
      toolName,
      sizeChars: sizeChars(payload),
      ...(items !== undefined ? { items } : {}),
      hint: `read_tool_result(callId="${callId}")`,
    },
  };
}

/**
 * Reduce an ARRAY payload: keep the largest prefix whose serialized size fits
 * `budget`, append an explicit omission marker. Objects are never split.
 */
function reduceArray(
  payload: unknown[],
  budget: number,
  callId: string,
  toolName: string,
): JsonValue {
  const kept: unknown[] = [];
  let acc = 2; // brackets
  const markerMin = sizeChars(
    omissionMarker(callId, toolName, 0, payload.length),
  );
  for (const item of payload) {
    const itemSize = sizeChars(item);
    if (acc + itemSize + 2 + markerMin > budget) break;
    acc += itemSize + 2;
    kept.push(item);
  }
  if (kept.length >= payload.length) return payload as JsonValue;
  kept.push(
    omissionMarker(callId, toolName, kept.length, payload.length - kept.length),
  );
  return kept as JsonValue;
}

/**
 * Reduce a NON-array payload to a head/tail text with a byte-accurate marker.
 * Never produces invalid JSON — the output is text-form (ToolResultOutput
 * type "text"), with the true total size stated so the model can decide.
 */
function reduceNonArray(
  payload: unknown,
  budget: number,
  callId: string,
  toolName: string,
): string {
  const serialized = sizeChars(payload);
  const headLen = Math.floor(budget * 0.6);
  const tailLen = Math.floor(budget * 0.4);
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const head = raw.slice(0, headLen);
  const tail = raw.slice(-tailLen);
  return `${head}\n…[+${Math.max(0, serialized - headLen - tailLen)} of ${serialized} chars omitted — read_tool_result(callId="${callId}") returns the full ${toolName} result]…\n${tail}`;
}

/**
 * §4.3 + §4.4 — apply the age-decay policy to a reconstructed tool result.
 * Idempotent; safe to run on every reconstruction.
 */
export function reduceToolResultOutput(
  output: ToolResultOutput,
  age: number,
  callId: string,
  toolName: string,
): ToolResultOutput {
  const budget = reductionBudgetForAge(age);

  if (budget === "summary") {
    // §B — content carriers floor at the excerpt tier, never a one-liner:
    // composing a public post from a summary is the failure this prevents.
    if (isContentCarrier(output.value)) {
      return {
        type: "text",
        value: reduceNonArray(output.value, 4_000, callId, toolName),
      };
    }
    return {
      type: "json",
      value: summaryEntry(callId, toolName, output.value),
    };
  }
  if (budget === Number.POSITIVE_INFINITY) return output;

  if (output.type === "json") {
    if (Array.isArray(output.value)) {
      return {
        type: "json",
        value: reduceArray(output.value, budget, callId, toolName),
      };
    }
    if (sizeChars(output.value) <= budget) return output;
    return {
      type: "text",
      value: reduceNonArray(output.value, budget, callId, toolName),
    };
  }
  if (output.value.length <= budget) return output;
  return {
    type: "text",
    value: reduceNonArray(output.value, budget, callId, toolName),
  };
}
