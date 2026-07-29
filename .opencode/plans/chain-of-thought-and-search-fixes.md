# Plan: Chain of Thought, Search Persistence, Reasoning Save, Image Error

## Problem Summary

4 issues from the previous implementation round:

1. **Layout wrong**: Reasoning and tool calls are in separate collapsibles BELOW text. User wants ONE collapsible ABOVE text with both reasoning + tool calls inside.
2. **Reasoning vanishes on chat switch**: `step.reasoning` / `step.reasoningText` are never saved to DB in `onFinish` — reasoning content is ephemeral/stream-only.
3. **Toolkit search text disappears**: `SearchInput` is uncontrolled — no `value` prop flows from parent. On re-render (triggered by `isFetching` state flip), the input loses its DOM value.
4. **Image paste error**: User pasted an image file path. The paste handler checks `item.kind === "file"` but macOS clipboard can also deliver file paths as string items. The error message is unclear.

---

## Fix 1: Unified Chain of Thought Collapsible (above text)

### Files to modify
- `src/app/.../assistant-message/assistant-message.tsx` — merge reasoning + tool calls into single `<ChainOfThought>`, place ABOVE text
- `src/app/.../assistant-message/collapsible-tool-section.tsx` — restructure to accept reasoning text alongside tool calls
- Delete `src/app/.../assistant-message/reasoning-block.tsx` — no longer needed

### Approach

**`collapsible-tool-section.tsx`** — rename conceptually to "chain of thought section":

```tsx
interface CollapsibleToolSectionProps {
  toolCalls: AnyToolUIPart[];
  reasoningTexts: string[];   // NEW
  isRunning: boolean;
}
```

- Inside the `CollapsibleContent`, render reasoning text FIRST (compact, small font, light color), then tool call cards below.
- Reasoning text styling: `text-[11px] text-muted-foreground/60 whitespace-pre-wrap leading-relaxed px-3 py-1.5` — inside a subtle `bg-muted/10 rounded-md` container.
- Header label: change from "Using N tools..." to a combined label like "Thinking" / "Show thinking" when there's reasoning, keeping the existing tool label when there are only tool calls.

**`assistant-message.tsx`** — reorder rendering:

```
1. ChainOfThought (reasoning + tool calls)  ← ABOVE
2. Text content (markdown)                  ← BELOW (always visible)
3. Copy button
```

Extract reasoning texts from segments:
```ts
const reasoningTexts = reasoningSegments
  .map(s => s.part.text)
  .filter(Boolean);
```

Pass both to single component:
```tsx
{(reasoningTexts.length > 0 || toolCalls.length > 0) && (
  <CollapsibleToolSection
    toolCalls={toolCalls}
    reasoningTexts={reasoningTexts}
    isRunning={isRunning}
  />
)}
```

Delete `reasoning-block.tsx`.

---

## Fix 2: Save Reasoning to DB (persistence across chat changes)

### File to modify
- `src/server/api/routers/nimits-jarvis/agent/setup.ts` — `onFinish` handler

### Current code (line ~413-421)
```ts
const stepText = stripToolResultEchoes(step.text);
if (stepText) {
  const restoredText = piiVault ? piiVault.restore(stepText) : stepText;
  assistantParts.push({ type: "text" as const, text: restoredText });
}
```

### Add after step text extraction
```ts
// Persist reasoning/thinking content for UI display
const stepReasoning = step.reasoningText
  ?? (step.reasoning?.length
    ? step.reasoning.map(r => r.text ?? "").filter(Boolean).join("\n")
    : "");
if (stepReasoning) {
  assistantParts.push({
    type: "reasoning" as const,
    text: stepReasoning,
    state: "done",
  });
}
```

### Impact analysis
- **Frontend loading** (`chat-context.tsx:74`): `msg.content as UIMessage["parts"]` — `{ type: "reasoning", text, state }` matches `ReasoningUIPart` from the AI SDK. The `segmentParts` function handles `isReasoningUIPart`. ✅ No change needed.
- **Agent context** (`build-context.ts`): `contentPartSchema` accepts `type: z.string()`, so reasoning parts pass validation. In `reconstructMessages`, they're filtered into `textContent` only if `type === "text"` (they have `type === "reasoning"`, so they're ignored for agent context). ✅ No change needed.
- **PII**: Reasoning text contains the model's thinking, which may include PII tokens. The existing PII vault restore for `stepText` handles the final text. Reasoning text should also be restored. However, `step.reasoningText` comes from the model's reasoning output, which should already have the PII-redacted tokens (since the model saw redacted input). Restoring PII in reasoning would convert tokens back to real values. We should NOT restore PII in reasoning — the reasoning references the redacted tokens the model saw. Just save as-is.

---

## Fix 3: Toolkit Search Text Persistence

### Files to modify
- `src/components/core/search-input.tsx` — add internal state for uncontrolled mode
- `src/app/.../toolkits/_components/toolkit-search.tsx` — accept and pass `value`
- `src/app/.../toolkits/_components/toolkits-client.tsx` — pass `value={search}`

### Approach

**`search-input.tsx`** — add internal state tracking:

```tsx
interface SearchInputProps extends React.ComponentProps<typeof Input> {
  debounceMs?: number;
  onSearch?: (query: string) => void;
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  ({ debounceMs = 500, onSearch, onChange, value, defaultValue, ...props }, ref) => {
    const [internalValue, setInternalValue] = useState(
      (value ?? defaultValue ?? "") as string,
    );
    const isControlled = value !== undefined;
    const displayValue = isControlled ? value : internalValue;

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const query = e.target.value;
        if (!isControlled) setInternalValue(query);
        onChange?.(e);
        // ...debounce logic
      },
      [debounceMs, onChange, onSearch, isControlled],
    );

    return <Input ref={ref} value={displayValue} onChange={handleChange} {...props} />;
  },
);
```

**`toolkit-search.tsx`** — forward value:

```tsx
interface ToolkitSearchProps {
  onSearch: (query: string) => void;
  isLoading?: boolean;
  value?: string;  // NEW
}

export function ToolkitSearch({ onSearch, isLoading, value }: ToolkitSearchProps) {
  return (
    <div className="relative w-full sm:w-72">
      {/* ...icon... */}
      <SearchInput
        placeholder="Search across 500+ toolkits..."
        className="pl-9"
        debounceMs={300}
        onSearch={onSearch}
        value={value}   // NEW
      />
    </div>
  );
}
```

**`toolkits-client.tsx`** — pass value:

```tsx
<ToolkitSearch
  onSearch={(q) => setSearch(q)}
  isLoading={isFetching}
  value={search}   // NEW
/>
```

---

## Fix 4: Image Error — Better Messaging + Path Regex

### Files to modify
- `src/app/.../use-chat-hook.ts` — improve `onError` image message
- `src/app/.../use-chat-hook.ts` — update `prepareSendMessagesRequest` regex to match full paths

### Current behavior
- `onError` checks `msg.includes("image")` → shows "This model does not support image input. Please use text only."
- The regex in `prepareSendMessagesRequest` only matches bare filenames (`image.png`), not full paths (`/Users/.../image.png`)

### Fix

**Update regex** to also match full file paths:
```ts
text: p.text.replace(
  /(?:^|\s)\/?[^\s]*\.(?:png|jpg|jpeg|gif|webp|svg|bmp|tiff)(?:\s|$)/gi,
  " ",
),
```

**Update error message** to be more actionable:
```ts
if (msg.includes("image") || msg.includes("Cannot read")) {
  showErrorToast(
    "Image input is not supported. Please remove any attached images and send your message as text only.",
  );
} else {
  showErrorToast(msg);
}
```

---

## Execution Order

1. Fix 1 (Chain of thought layout) — most visible UX issue
2. Fix 2 (Reasoning persistence) — enables Fix 1 to work across chat switches
3. Fix 3 (Search text persistence) — independent, small change
4. Fix 4 (Image error) — independent, small change

## Verification

- Typecheck: `npx tsc --noEmit`
- Build: `npm run build:local` (if available)
- Manual: send a message, verify chain of thought section appears above text with reasoning + tool calls
- Manual: switch chats and back — reasoning should persist
- Manual: search toolkits — text should remain in input after results load
- Manual: try pasting an image — should see clear error message
