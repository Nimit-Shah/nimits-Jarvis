import { z } from "zod";
import { skillSlugSchema } from "../../skill-utils";

export const installSkillSchema = z.object({
  source: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+(@[\w.-]+)?$/, "must be owner/repo or owner/repo@skill")
    .describe("owner/repo or owner/repo@skill, exactly as returned by find_skill"),
  query: z
    .string()
    .max(200)
    .optional()
    .describe("The find_skill query that led here, kept as an audit trail"),
  slug: skillSlugSchema
    .optional()
    .describe("Optional slug override — must match frontmatter name"),
});

export type InstallSkillInput = z.infer<typeof installSkillSchema>;
