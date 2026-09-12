import { z } from "zod";
import { skillSlugSchema } from "./skill-utils";

export const importSkillInput = z.object({
  /** Git URL (.git, github.com/…) or a raw SKILL.md URL. */
  url: z.string().url().max(2000),
  /** Optional slug override — must match frontmatter name when SKILL.md is authoritative. */
  slug: skillSlugSchema.optional(),
  /** Subdirectory inside a git repo holding the skill (Discover entries). */
  subdir: z
    .string()
    .regex(/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/, "subdir must be a relative path")
    .max(200)
    .optional(),
});

export type ImportSkillInput = z.infer<typeof importSkillInput>;
