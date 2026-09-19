import { z } from "zod";

export const listMcpOriginRulesSchema = z.object({
  serverId: z.string().cuid(),
});

export type ListMcpOriginRulesInput = z.infer<typeof listMcpOriginRulesSchema>;
