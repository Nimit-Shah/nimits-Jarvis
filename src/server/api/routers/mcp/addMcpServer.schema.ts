import { z } from "zod";

export const addMcpServerSchema = z.object({
  instanceId: z.string().cuid(),
  label: z.string().min(1).max(60),
  name: z.string().regex(/^[a-z0-9-]{1,32}$/, "lowercase letters, numbers, hyphens"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export type AddMcpServerInput = z.infer<typeof addMcpServerSchema>;
