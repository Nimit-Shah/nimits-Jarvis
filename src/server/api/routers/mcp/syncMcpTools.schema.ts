import { z } from "zod";

export const syncMcpToolsSchema = z.object({
  serverId: z.string().cuid(),
});

export type SyncMcpToolsInput = z.infer<typeof syncMcpToolsSchema>;
