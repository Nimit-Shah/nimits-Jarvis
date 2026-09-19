import { z } from "zod";

export const deleteMcpOriginRuleSchema = z.object({
  ruleId: z.string().cuid(),
});

export type DeleteMcpOriginRuleInput = z.infer<typeof deleteMcpOriginRuleSchema>;
