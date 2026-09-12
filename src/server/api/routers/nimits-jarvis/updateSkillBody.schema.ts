import { z } from "zod";
import { skillSlugSchema } from "./skill-utils";

export const updateSkillBodyInput = z.object({
  slug: skillSlugSchema,
  /** Full new SKILL.md text (frontmatter + body). Validated before writing. */
  body: z.string().min(1).max(200_000),
});

export type UpdateSkillBodyInput = z.infer<typeof updateSkillBodyInput>;
