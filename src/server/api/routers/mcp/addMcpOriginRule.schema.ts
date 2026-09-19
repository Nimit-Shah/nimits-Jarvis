import { z } from "zod";
import { normalizeOriginPattern } from "~/server/lib/browser/origins";

export const addMcpOriginRuleSchema = z.object({
  serverId: z.string().cuid(),
  pattern: z
    .string()
    .min(1)
    .max(120)
    .refine(
      (v) => {
        try {
          normalizeOriginPattern(v);
          return true;
        } catch {
          return false;
        }
      },
      { message: "expected a bare site like tradingview.com" },
    ),
  kind: z.enum(["allow", "block"]).default("allow"),
  notes: z.string().max(200).optional(),
});

export type AddMcpOriginRuleInput = z.infer<typeof addMcpOriginRuleSchema>;
