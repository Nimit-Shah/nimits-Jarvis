import { z } from "zod";

export const listMcpToolsSchema = z.object({
  serverId: z.string().cuid(),
});

export type ListMcpToolsInput = z.infer<typeof listMcpToolsSchema>;
