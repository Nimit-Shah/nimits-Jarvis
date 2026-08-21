import { z } from "zod";

export const deleteMcpServerSchema = z.object({
  serverId: z.string().cuid(),
});

export type DeleteMcpServerInput = z.infer<typeof deleteMcpServerSchema>;
