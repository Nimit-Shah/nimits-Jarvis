import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Unified diff for pre-flight. Server-side (never the model's intent — the
 * real effect). Display truncates at ~200 lines in the card; the full diff
 * is stored on the FileChange row.
 */
export const DIFF_DISPLAY_MAX_LINES = 200;

/** sha256 of file content — digest binding for approvals (TOCTOU guard). */
export async function sha256File(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

export function sha256Buffer(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Minimal unified-diff generator (no dependency). */
export function unifiedDiff(
  before: string,
  after: string,
  opts: { context?: number; fromLabel?: string; toLabel?: string } = {},
): string {
  const context = opts.context ?? 3;
  const from = opts.fromLabel ?? "a";
  const to = opts.toLabel ?? "b";

  const a = before.split("\n");
  const b = after.split("\n");

  // LCS-based line diff
  const n = a.length;
  const m = b.length;
  // Guard against pathological sizes (1MB caps already bound this)
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? (lcs[i + 1]![j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0);
    }
  }

  type HunkOp = { t: " " | "-" | "+"; line: string };
  const ops: HunkOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i]! });
      i++;
      j++;
    } else if ((lcs[i + 1]![j] ?? 0) >= (lcs[i]![j + 1] ?? 0)) {
      ops.push({ t: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ t: "+", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ t: "-", line: a[i++]! });
  while (j < m) ops.push({ t: "+", line: b[j++]! });

  if (ops.every((o) => o.t === " ")) return ""; // no changes

  // Group into hunks with `context` lines of surrounding stability
  const lines: string[] = [`--- ${from}`, `+++ ${to}`];
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx]!.t === " ") {
      idx++;
      continue;
    }
    // find hunk start (pad back `context` stable lines)
    let start = idx;
    let back = 0;
    while (start > 0 && back < context && ops[start - 1]!.t === " ") {
      start--;
      back++;
    }
    // find hunk end: advance until `context` consecutive stable lines or EOF
    let end = idx;
    let stableRun = 0;
    while (end < ops.length) {
      if (ops[end]!.t === " ") {
        stableRun++;
        if (stableRun > context) break;
      } else {
        stableRun = 0;
      }
      end++;
    }
    // emit hunk
    const hunkOps = ops.slice(start, end);
    let aStart = 1;
    let bStart = 1;
    for (let k = 0; k < start; k++) {
      if (ops[k]!.t !== "+") aStart++;
      if (ops[k]!.t !== "-") bStart++;
    }
    const aCount = hunkOps.filter((o) => o.t !== "+").length;
    const bCount = hunkOps.filter((o) => o.t !== "-").length;
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of hunkOps) lines.push(o.t + o.line);
    idx = end;
  }

  return lines.join("\n");
}

/** Truncate for card display; the full diff stays on the row. */
export function truncateDiffForDisplay(diff: string): { display: string; truncated: boolean; totalLines: number } {
  const lines = diff.split("\n");
  if (lines.length <= DIFF_DISPLAY_MAX_LINES) {
    return { display: diff, truncated: false, totalLines: lines.length };
  }
  return {
    display: [...lines.slice(0, DIFF_DISPLAY_MAX_LINES), `… [${lines.length - DIFF_DISPLAY_MAX_LINES} more diff lines — full diff stored]`].join("\n"),
    truncated: true,
    totalLines: lines.length,
  };
}
