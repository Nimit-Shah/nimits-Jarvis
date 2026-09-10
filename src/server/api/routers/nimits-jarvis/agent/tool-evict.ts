/**
 * Lossless tool-result eviction (docs/TOKEN_EFFICIENCY.md §2).
 *
 * Runs at READ time (message reconstruction) so the database keeps authentic
 * history while the LLM payload shrinks:
 *
 * §2.1 — Spent COMPOSIO_SEARCH_TOOLS results carry tool SCHEMAS, not data.
 *        Once a slug from a result has actually been invoked later (directly or
 *        inside COMPOSIO_MULTI_EXECUTE_TOOL), the result body has zero residual
 *        value and is collapsed to a one-line stub naming the selection. If no
 *        selection followed, the result is kept whole — the model is still
 *        choosing.
 * §2.2 — Composio per-result boilerplate is stripped from every tool result:
 *        `logId`, `successful: true`, `error: null` (kept when false/non-null).
 *
 * Both transforms are idempotent and PII-token-safe (they never touch values).
 */

import type { ToolResultOutput } from "./types";

export const SEARCH_TOOLS = "COMPOSIO_SEARCH_TOOLS";
export const MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";

const BOILERPLATE_KEYS = new Set(["logId"]);

type DynamicToolPart = {
  type?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
};

/** All tool slugs invoked anywhere in this message batch, uppercased. */
export function collectInvokedSlugs(
  messages: Array<{ role: string; content: unknown }>,
): Set<string> {
  const invoked = new Set<string>();

  const addSlugs = (input: unknown) => {
    if (!input || typeof input !== "object") return;
    const tools =
      (input as Record<string, unknown>).tools ??
      (input as Record<string, unknown>).executions;
    if (!Array.isArray(tools)) return;
    for (const t of tools) {
      if (t && typeof t === "object") {
        const slug = (t as Record<string, unknown>).tool_slug;
        if (typeof slug === "string" && slug) invoked.add(slug.toUpperCase());
      }
    }
  };

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const parts = Array.isArray(msg.content) ? msg.content : [];
    for (const part of parts) {
      const p = part as DynamicToolPart;
      if (p.type !== "dynamic-tool") continue;
      const name = p.toolName ?? "";
      if (name === MULTI_EXECUTE_TOOL) {
        addSlugs(p.input);
      } else if (name) {
        invoked.add(name.toUpperCase());
      }
    }
  }
  return invoked;
}

function slugsFromResult(result: unknown): Set<string> {
  const slugs = new Set<string>();
  if (!result || typeof result !== "object") return slugs;
  const r = result as Record<string, unknown>;
  for (const key of ["primary_tool_slugs", "related_tool_slugs"]) {
    const v = r[key];
    if (typeof v === "string") {
      for (const s of v.split(/[,\s]+/)) if (s) slugs.add(s.toUpperCase());
    } else if (Array.isArray(v)) {
      for (const s of v) if (typeof s === "string") slugs.add(s.toUpperCase());
    }
  }
  return slugs;
}

/**
 * §2.1 — Collapse a SEARCH_TOOLS result to `{searched, selected}` when a slug
 * it returned was actually invoked later. Returns null when the result must be
 * kept whole (no selection yet, or unexpected shape).
 */
export function collapseSpentSearchResult(
  input: unknown,
  output: unknown,
  invokedSlugs: Set<string>,
): ToolResultOutput | null {
  // Stored parts are plain payloads; a `{type, value}` wrapper from a
  // differently-shaped era is unwrapped defensively.
  if (
    output &&
    typeof output === "object" &&
    "type" in (output as Record<string, unknown>) &&
    "value" in (output as Record<string, unknown>)
  ) {
    output = (output as Record<string, unknown>).value;
  }
  const data = (output as Record<string, unknown> | undefined)?.data;
  const results = Array.isArray(
    (data as Record<string, unknown> | undefined)?.results,
  )
    ? ((data as Record<string, unknown>).results as unknown[])
    : null;
  if (!results || results.length === 0) return null;

  let selected: string | null = null;
  for (const r of results) {
    for (const slug of slugsFromResult(r)) {
      if (invokedSlugs.has(slug)) {
        selected = slug;
        break;
      }
    }
    if (selected) break;
  }
  if (!selected) return null;

  // `searched` = what the model asked for: the use_case(s) from the tool-call
  // input, falling back to the first result's own use_case.
  const queries = (input as Record<string, unknown> | undefined)?.queries;
  let searched: string | undefined;
  if (Array.isArray(queries)) {
    searched = queries
      .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
      .map((q) => {
        const uc = q.use_case;
        return typeof uc === "string" ? uc : "";
      })
      .filter(Boolean)
      .join("; ");
  }
  if (!searched) {
    const first = results[0] as Record<string, unknown> | undefined;
    searched = typeof first?.use_case === "string" ? first.use_case : undefined;
  }

  return {
    type: "json",
    value: { searched: searched ?? "", selected },
  };
}

/**
 * §2.2 — Recursively strip Composio per-result boilerplate. Only `logId`,
 * `successful === true` and `error === null` are dropped — everything else
 * (including `successful: false` and error messages) is preserved.
 */
export function stripToolResultBoilerplate<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) {
      out.push(stripToolResultBoilerplate(v, depth + 1));
    }
    return out as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (BOILERPLATE_KEYS.has(k)) continue;
      if (k === "successful" && v === true) continue;
      if (k === "error" && v === null) continue;
      out[k] = stripToolResultBoilerplate(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
