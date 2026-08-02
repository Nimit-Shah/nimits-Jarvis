/**
 * PII Transport Shield — Final network-layer interceptor.
 *
 * This is the **last line of defense** before any payload leaves the
 * runtime and hits an external LLM API (OpenRouter, Anthropic direct,
 * Anthropic, etc.).
 *
 * Unlike the existing PIIVault (which is opt-in and applied per-layer),
 * this shield operates on the fully-assembled message array right before
 * it is serialized into the HTTP request body. It catches:
 *
 * - PII that leaked through tool results despite wrapToolExecutors
 * - PII in system prompts (identity prompt, soul prompt, user prompt)
 * - PII in the user's new message that arrived from the web request
 * - PII in reasoning/chain-of-thought text that the model generated
 *   in prior turns and is now being replayed as context
 *
 * Design decisions:
 * - Uses the existing PIIVault for detection & tokenization (no duplication)
 * - Operates on the string-serialized form of each message content,
 *   catching PII regardless of how it's nested in tool-call inputs,
 *   multipart content arrays, or plain text.
 * - Session-scoped: a new shield is created per request and shares the
 *   same PIIVault, so tokens are consistent across all layers.
 * - Local (Ollama) models are never intercepted — they run on-device.
 */

import { PIIVault } from "./pii-tokenizer";

// ─── Types ──────────────────────────────────────────────────────────

type MessageRole = "system" | "user" | "assistant" | "tool";

interface ContentPart {
  type: string;
  text?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  [key: string]: unknown;
}

interface TransportMessage {
  role: MessageRole;
  content: string | ContentPart[];
  [key: string]: unknown;
}

// ─── Shield ─────────────────────────────────────────────────────────

export class PIITransportShield {
  constructor(private readonly vault: PIIVault) {}

  /**
   * Deep-scrub a single message, handling both string content and
   * multipart content arrays (tool-call inputs, tool results, text parts).
   */
  async scrubMessage<T extends TransportMessage>(msg: T): Promise<T> {
    if (typeof msg.content === "string") {
      return { ...msg, content: await this.vault.redact(msg.content) };
    }

    if (Array.isArray(msg.content)) {
      const scrubbedParts = await Promise.all(
        msg.content.map((part) => this.scrubContentPart(part)),
      );
      return { ...msg, content: scrubbedParts };
    }

    return msg;
  }

  /**
   * Scrub an entire message array — the final checkpoint before
   * the payload is serialized and sent over the wire.
   */
  async scrubPayload<T extends TransportMessage>(messages: T[]): Promise<T[]> {
    return Promise.all(messages.map((msg) => this.scrubMessage(msg)));
  }

  /**
   * Scrub a plain text string. Convenience method for system prompts
   * or other standalone strings that aren't part of a message array.
   */
  async scrubText(text: string): Promise<string> {
    return this.vault.redact(text);
  }

  // ─── Private ────────────────────────────────────────────────────

  private async scrubContentPart(part: ContentPart): Promise<ContentPart> {
    const result = { ...part };

    // Text parts (most common)
    if (result.type === "text" && typeof result.text === "string") {
      result.text = await this.vault.redact(result.text);
    }

    // Tool-call inputs — deep-walk the input object
    if (result.type === "tool-call" && result.input) {
      result.input = (await this.vault.redactToolResult(result.input)) as Record<
        string,
        unknown
      >;
    }

    // Tool results — deep-walk the output
    if (result.type === "tool-result" && result.output !== undefined) {
      result.output = await this.vault.redactToolResult(result.output);
    }

    // Reasoning/thinking text — match historical reasoning that was stored
    // with real PII values (after B1 fix) and needs to be re-tokenized
    // before the LLM sees it when replayed as context.
    if (result.type === "reasoning" && typeof result.text === "string") {
      result.text = await this.vault.redact(result.text);
    }

    return result;
  }
}
