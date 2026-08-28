/**
 * Extract gloss for the collapsed reasoning line.
 * Priority:
 *  1. `SUMMARY: <line>` — return as-is (no word split, no bold wrapping)
 *  2. Bold markdown `**Title**` inside reasoning — 3-word-style title (e.g. **Finding Gmail Tools**)
 *  3. First sentence truncated to 10 words
 */
export function extractGloss(text: string): string {
  if (!text) return "";
  const summaryMatch = text.match(/^\s*SUMMARY:\s*(.+)$/m);
  if (summaryMatch?.[1]) return summaryMatch[1].trim().slice(0, 80);
  const boldMatch = text.match(/\*\*(.+?)\*\*/);
  if (boldMatch?.[1]) return boldMatch[1].trim().slice(0, 80);
  const firstSentence = text.split(/[.!\n]/)[0]?.trim() ?? "";
  if (!firstSentence) return text.split(/\s+/).slice(0, 10).join(" ");
  const words = firstSentence.split(/\s+/).slice(0, 10).join(" ");
  return words.length > 3 ? words : text.split(/\s+/).slice(0, 10).join(" ");
}

/** Strip the SUMMARY: line and leading bold title from display of full reasoning */
export function stripSummaryLine(text: string): string {
  return text.replace(/^\s*SUMMARY:\s*.+$/m, "").replace(/^\s*\*\*(.+?)\*\*\s*/, "").trim();
}
