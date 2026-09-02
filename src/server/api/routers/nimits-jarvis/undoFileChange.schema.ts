import { z } from "zod";

export const undoFileChangeInput = z.object({
  fileChangeId: z.string(),
});
