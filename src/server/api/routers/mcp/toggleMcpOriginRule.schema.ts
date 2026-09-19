import { z } from "zod";

export const toggleMcpOriginRuleSchema = z.object({
  ruleId: z.string().cuid(),
  enabled: z.boolean(),
});

export type ToggleMcpOriginRuleInput = z.infer<typeof toggleMcpOriginRuleSchema>;
