import { z } from "zod";

export const toggleMcpServerSchema = z.object({
  serverId: z.string().cuid(),
  enabled: z.boolean(),
});

export type ToggleMcpServerInput = z.infer<typeof toggleMcpServerSchema>;
