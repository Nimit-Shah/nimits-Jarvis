import { z } from "zod";

export const listSkillsInput = z.object({
  instanceId: z.string().optional(),
  /** Include disabled rows (Settings needs them; composer hides them). */
  includeDisabled: z.boolean().default(false),
});

export type ListSkillsInput = z.infer<typeof listSkillsInput>;
