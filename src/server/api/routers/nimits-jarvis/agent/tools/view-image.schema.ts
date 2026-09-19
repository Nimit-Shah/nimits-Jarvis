import { z } from "zod";

export const viewImageSchema = z.object({
  imageId: z.string().cuid().describe("Attachment id from a $image reference"),
  reason: z.string().max(200).optional().describe("Why the bytes are needed again"),
});

export type ViewImageInput = z.infer<typeof viewImageSchema>;
