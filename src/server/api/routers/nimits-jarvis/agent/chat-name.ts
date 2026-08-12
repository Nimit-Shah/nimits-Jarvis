/**
 * Deterministic one-line chat heading derivation.
 *
 * Every chat gets a human-readable heading from the first user prompt. This is
 * derived server-side (no LLM call) so web, telegram, and cron all share the
 * same naming code path. The heading is display-only — it is never sent to the
 * LLM, so it stores the real (unredacted) user text.
 */

const MAX_CHAT_NAME_LENGTH = 60;

/** Placeholder names that signal "chat has never been auto-named". */
const PLACEHOLDER_NAMES = new Set(["New Chat", "First chat", ""]);

/**
 * Returns true when the chat name is still an auto-naming placeholder, meaning
 * the first-prompt heading has not been derived yet. Manual renames are never
 * clobbered because they don't match these values.
 */
export function isPlaceholderChatName(
  name: string | null | undefined,
): boolean {
  if (!name) return true;
  return PLACEHOLDER_NAMES.has(name.trim());
}

/**
 * Collapses a user prompt into a single-line heading: consecutive whitespace
 * and newlines become single spaces, then the result is trimmed and capped at
 * MAX_CHAT_NAME_LENGTH with an ellipsis.
 *
 * Cron jobs send their prompt wrapped in `<scheduled-task>...</scheduled-task>`
 * tags; those are stripped first so the heading is the plain task text.
 */
export function deriveChatName(userMessage: string): string {
  const unwrapped = userMessage.replace(/<\/?scheduled-task>/gi, " ").trim();
  const oneLine = unwrapped.replace(/\s+/g, " ").trim();
  if (oneLine.length <= MAX_CHAT_NAME_LENGTH) {
    return oneLine;
  }
  return `${oneLine.slice(0, MAX_CHAT_NAME_LENGTH - 1)}…`;
}
