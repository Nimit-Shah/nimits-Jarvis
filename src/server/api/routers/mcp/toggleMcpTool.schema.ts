import { z } from "zod";

export const toggleMcpToolSchema = z.object({
  toolId: z.string().cuid(),
  enabled: z.boolean().optional(),
  cronSafe: z.boolean().optional(),
});

export type ToggleMcpToolInput = z.infer<typeof toggleMcpToolSchema>;
