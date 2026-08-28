# Plan: Collapsed Reasoning / Tool-Call Summary (Claude.ai-inspired) — Implemented

Status: Sequencing in gloss is working — locked for now. Upcoming changes will be planned separately. Plan mode exited to build and file saved for future reference.

## Goal
Replace static "Used N tools" label with a state-aware, one-line live collapsed summary. Collapsed = glanceable status. Expanded = full trace. Model after Claude.ai's collapsed extended-thinking panel: a rolling one-liner that updates in place, settling into a final aggregate once the turn completes.

## State Machine (collapsed single line)

**State 0 — Reasoning (no tool yet / between tools)**
- Shows live short gloss of current reasoning step (1-line, from `SUMMARY:` as-is else `**Title**` bold else 10-word first sentence). No loader (text-update signals activity).
- Example: `Retrieving Mail Data`

**State 1 — Tool call initiated**
- On `tool_use` emission, line switches to machine identifier: `Used SEARCH_TOOLS`
- Loader appears (fixes bug where spinner was missing before execution start).

**State 2 — Tool executing**
- While awaiting result: `Used N tools` (count of concurrent input-available/streaming)
- Loader stays active. If another reasoning follows a tool result, goes back to State 0 with new gloss.

**State 3 — Turn complete**
- Loader gone. Collapsed becomes stacked icons (existing, untouched) + human-readable aggregate: `Used Gmail Integration, Loaded and used tools` via `display_name` mapping. Machine name → display name → aggregate.
- Always ends on tools aggregate, not gloss (as requested: “always end up with tools called”).

Collapsed interleaving: based on `mostRecent = chainItems[chainItems.length-1]` — when most recent is reasoning, show its gloss; when most recent is tool, show `Used ...` aggregate/count. This yields the observed sequence: `Retrieving Mail Data` → `Used Search Tools` → `Used Search Tools, Multi Execute Tool` → `Used Search Tools, Multi Execute Tool, Remote Workbench` → `Categorizing New Inquiries` → final `Used Search Tools, Multi Execute Tool, Remote Workbench` then prompt output.

## Expand Behavior
- Tapping collapsed row at any state (0–2 included) expands to full trace.
- Expanded reasoning: bold gloss single line (`truncate`) + full paragraph below (italic, `stripSummaryLine` body). All reasoning text tints `text-destructive/80` and dots `bg-destructive/60` when turn has any tool failure; only the failed tool's icon gets `ring-destructive`.
- Per-tool rows: Title-cased `display_name` via `formatToolName` (not raw `SEARCH_TOOLS`), with Input/Output compact markdown collapsible.

## Backend / Data Requirements — Implemented

1. **Reasoning gloss without local model** — `src/server/api/routers/nimits-jarvis/agent/system-prompt.ts:227` added `REASONING_GLOSS_INSTRUCTION`:
   ```
   SUMMARY: <≤10 words, verb phrase, what you will do next>
   ```
   Injected via `buildSystemPrompt()` after `MESSAGING_GUIDELINES` (cached via `anthropic.cacheControl`). Client extracts via `extractGloss()`: `SUMMARY:` line as-is (up to 80 chars), else `**Title**` bold markdown (e.g. `**Finding Gmail Tools**`), else first sentence 10 words. No extra LLM call.

2. **Tool display_name persisted** — `src/server/api/routers/nimits-jarvis/agent/setup.ts:535` stores `display_name: formatToolDisplayName(tc.toolName)` on `dynamic-tool` parts; added same optional field to schemas.

3. **Gloss persisted** — `setup.ts:544` stores `gloss` alongside `text` on `type:"reasoning"` parts, extracted via `extractReasoningGloss()` helper (same priority as client). Added `gloss?: string` to `src/server/api/routers/nimits-jarvis/agent/types.ts:31` and `src/server/api/routers/nimits-jarvis/agent/context/build-context.ts:48,216`.

4. **Persistence order fixed** — `setup.ts:531` now persists `reasoning` **before** `dynamic-tool` per step (was tools → text → reasoning), so `chainItems` order is thinking → acting as intended.

5. **Redaction** — `pii-transport-shield.ts:114` and `setup.ts:182` redact `gloss` and `display_name` alongside `text`.

## UI Changes — Implemented

- **Helper** `src/components/ui/tool-calls-section-utils/reasoning-gloss.ts` — `extractGloss()`, `stripSummaryLine()` (also strips leading `**Title**`).
- **`src/components/ui/tool-calls-section.tsx:100-163`**
  - `lastReasoningGloss` + `mostRecentGloss` (from `chainItems[last]`), `aggregatedSummary` with dynamic fit to one line: tries 5 names → `Used t1, t2, t3, t4, t5 and more`, falls back to 4/3/2 by `label.length <=58`, else `Used first and more`.
  - `collapsedLabel`/`showLoader` state machine as described above.
  - Header: `flex min-w-0` + `truncate whitespace-nowrap` on label, stacked icons hidden for reasoning-only turns, failed icon gets `ring-1 ring-destructive/50`.
- **`src/app/(authenticated)/dashboard/_components/chat/assistant-message/assistant-message.tsx:44`** — `mapToToolCallEntry` now prefers `display_name` via `formatToolName` (Title Case) for `message`/`integration_name`.

## Edge Cases Handled

- Reasoning-only turn, no tools: collapsed ends on last gloss, no icon row.
- Tool failure: collapsed `Used X — failed` or `aggregate — failed`, header `XCircle`, all reasoning red, only failed icon ring-red.
- Parallel tools: batched `Used N tools` (no flicker).
- 5+ tools: dynamic `and more` truncation guarantees single line.

## Acceptance Criteria (verified via pnpm typecheck + pnpm build:local)

- [x] Collapsed never shows generic `Used N tool` during State 0 — shows live gloss.
- [x] Loader visible for full State 1–2 duration, not just mid-execution.
- [x] Final collapsed shows stacked icons + aggregate sentence, truncated to one line.
- [x] Expand works mid-stream (State 0–2) and shows gloss + full body per step.
- [x] Failure has distinct visual (header — failed, all reasoning red, failed icon ring).

## Future
Sequencing in gloss is working; upcoming changes will be planned later under a new plan file.
