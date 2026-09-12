import { z } from "zod";
import { skillSlugSchema } from "./skill-utils";

export const deleteSkillInput = z.object({
  slug: skillSlugSchema,
});

export type DeleteSkillInput = z.infer<typeof deleteSkillInput>;
