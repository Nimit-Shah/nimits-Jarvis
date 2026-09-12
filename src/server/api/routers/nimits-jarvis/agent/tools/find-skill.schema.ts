import { z } from "zod";

export const findSkillSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe("Search terms describing the capability needed"),
  triedExisting: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "Briefly state which existing tool(s) or skill(s) you checked and why none fit",
    ),
  owner: z
    .string()
    .regex(/^[\w.-]+$/, "owner must be a GitHub owner")
    .optional()
    .describe("Optional GitHub owner to scope the search to"),
});

export type FindSkillInput = z.infer<typeof findSkillSchema>;
