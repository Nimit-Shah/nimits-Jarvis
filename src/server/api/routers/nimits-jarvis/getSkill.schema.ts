import { z } from "zod";
import { skillSlugSchema } from "./skill-utils";

export const getSkillInput = z.object({
  slug: skillSlugSchema,
});

export type GetSkillInput = z.infer<typeof getSkillInput>;
