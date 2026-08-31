/**
 * toSpeakable — guaranteed speakable transform for TTS input.
 *
 * The voice-mode prompt asks the model for plain spoken words, but free/flash
 * models still emit markdown sometimes. This is the server-of-last-resort on
 * the client: whatever reaches /api/tts must be pronounceable, because the TTS
 * engine reads characters literally (Claude voice recording, frame_150:
 * "no symbols, no markdown, no currency signs or math notation").
 */

export function toSpeakable(input: string): string {
  let t = input;

  // Fenced code blocks → drop entirely (never read code aloud)
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/`([^`]+)`/g, "$1");

  // Headings → plain line
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");

  // Bold/italic markers → remove, keep content
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/\*([^*]+)\*/g, "$1");
  t = t.replace(/__([^_]+)__/g, "$1");
  t = t.replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1$2");

  // Strikethrough
  t = t.replace(/~~([^~]+)~~/g, "$1");

  // Links → keep the label only; bare URLs → drop (nobody wants a URL read out)
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  t = t.replace(/https?:\/\/\S+/g, " a link ");

  // List markers → fold into flowing sentence
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  t = t.replace(/^\s*\d+[.)]\s+/gm, "");

  // Blockquotes
  t = t.replace(/^\s*>\s?/gm, "");

  // Emojis / pictographs (TTS reads their names aloud) — remove
  t = t.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu,
    "",
  );

  // Symbols → spoken words
  t = t.replace(/\s*:\s*(?:\/\/)?/g, ": "); // keep colons in normal prose
  t = t.replace(/\$\s?(\d+(?:[.,]\d+)?)/g, "$1 dollars");
  t = t.replace(/(\d+(?:[.,]\d+)?)\s?%/g, "$1 percent");
  t = t.replace(/(\d+)\s?&/g, "$1 and");
  t = t.replace(/\s&\s/g, " and ");
  t = t.replace(/\s{2,}@\s{2,}/g, " at ");
  t = t.replace(/\s+[-–—]\s+/g, " — "); // em dash reads fine; collapse spacing
  t = t.replace(/([a-z])\/([a-z])/g, "$1 or $2"); // "yes/no" → "yes or no"

  // Table pipes → separator words
  t = t.replace(/\s*\|\s*/g, ", ");

  // Collapse whitespace/blank lines into single spaces (TTS handles prosody)
  t = t.replace(/\s*\n+\s*/g, ". ");
  t = t.replace(/\s{2,}/g, " ");

  // Trim dangling separators
  t = t.replace(/^[\s.·•]+/, "").replace(/\s*[·•]+\s*$/, "");

  return t.trim();
}
