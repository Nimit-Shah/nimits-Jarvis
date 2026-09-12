import { z } from "zod";

export const loadSkillSchema = z.object({
  slug: z.string().describe("Slug of the skill to load, from AVAILABLE SKILLS"),
});

export type LoadSkillInput = z.infer<typeof loadSkillSchema>;
