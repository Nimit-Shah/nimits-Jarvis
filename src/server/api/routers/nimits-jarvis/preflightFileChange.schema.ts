import { z } from "zod";

export const preflightFileChangeInput = z.object({
  instanceId: z.string(),
  chatId: z.string(),
  // The model's streamed tool-call id (from the input-available UI part).
  // Keys the FileChange row — the card correlates by it, addToolOutput
  // resumes by it. Idempotent: re-preflight of the same call updates in place.
  toolCallId: z.string().min(1),
  op: z.enum(["edit", "write", "delete", "mkdir", "move"]),
  path: z.string().min(1),
  toPath: z.string().optional(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  expectedOccurrences: z.number().int().min(1).default(1),
  content: z.string().optional(),
  mode: z.enum(["create", "overwrite"]).optional(),
});

export type PreflightFileChangeInput = z.infer<typeof preflightFileChangeInput>;
