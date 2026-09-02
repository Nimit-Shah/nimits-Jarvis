import { z } from "zod";

export const executeFileChangeInput = z.object({
  fileChangeId: z.string(),
  approve: z.boolean(), // false = rejected (rejectReason optional)
  rejectReason: z.string().max(500).optional(),
});
