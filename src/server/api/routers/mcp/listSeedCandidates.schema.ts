import { z } from "zod";

export const listSeedCandidatesSchema = z.object({
  instanceId: z.string().cuid(),
});

export type ListSeedCandidatesInput = z.infer<typeof listSeedCandidatesSchema>;
