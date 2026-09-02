import type { UserModelMessage } from "ai";

type ProviderOptions = UserModelMessage["providerOptions"];

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | { [key: string]: JsonValue }
  | JsonValue[];

export type ToolResultOutput =
  | { type: "text"; value: string }
  | { type: "json"; value: JsonValue };

export type ReconstructedMessage =
  | { role: "user"; content: string; providerOptions?: ProviderOptions }
  | {
      role: "assistant";
      content:
        | string
        | Array<
            | { type: "text"; text: string }
            | {
                type: "tool-call";
                toolCallId: string;
                toolName: string;
                input: Record<string, unknown>;
              }
            | { type: "reasoning"; text: string; gloss?: string }
          >;
      providerOptions?: ProviderOptions;
    }
  | {
      role: "tool";
      content: Array<{
        type: "tool-result";
        toolCallId: string;
        toolName: string;
        output: ToolResultOutput;
      }>;
      providerOptions?: ProviderOptions;
    };

/**
 * Per-message filesystem access mode. NOT persisted — travels in the chat
 * request body beside isVoice, is clamped server-side against the instance
 * ceiling (fsWriteAllowed) and the message source, and resets to "read-only"
 * on every new chat. See docs/PHASE_A_FS_ACCESS.md §2 and §5.
 */
export type FsAccessMode = "read-only" | "full";
