import { z } from "zod";

export const updateMcpServerSchema = z.object({
  serverId: z.string().cuid(),
  label: z.string().min(1).max(60).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
});

export type UpdateMcpServerInput = z.infer<typeof updateMcpServerSchema>;
