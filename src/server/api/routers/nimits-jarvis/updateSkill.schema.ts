import { z } from "zod";
import { skillSlugSchema } from "./skill-utils";

export const updateSkillInput = z.object({
  slug: skillSlugSchema,
  displayName: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(2000).optional(),
  enabled: z.boolean().optional(),
  trustTier: z.enum(["untrusted", "verified", "trusted"]).optional(),
});

export type UpdateSkillInput = z.infer<typeof updateSkillInput>;
