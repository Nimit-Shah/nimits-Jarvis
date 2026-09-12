import { z } from "zod";

/**
 * SKILL.md frontmatter. `name` + `description` are required — a file missing
 * either is rejected at install with the reason shown. `trust_tier` is
 * NEVER read here (a hostile skill would declare itself trusted); its
 * presence is a Phase-2 scan finding. Unknown keys are preserved but not
 * acted on so third-party skills carrying other runtimes' fields install.
 */
export const skillFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "name must be a slug: lowercase, [a-z0-9-]"),
  description: z.string().min(1),
  tools_required: z.array(z.string()).default([]),
  state_scope: z.enum(["none", "session", "persistent"]).default("none"),
  version: z.string().optional(),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;
