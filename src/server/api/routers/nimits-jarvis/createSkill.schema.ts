import { z } from "zod";
import { skillSlugSchema } from "./skill-utils";

export const createSkillInput = z.object({
  slug: skillSlugSchema,
  description: z.string().min(1).max(2000),
  displayName: z.string().min(1).max(100).optional(),
});

export type CreateSkillInput = z.infer<typeof createSkillInput>;
