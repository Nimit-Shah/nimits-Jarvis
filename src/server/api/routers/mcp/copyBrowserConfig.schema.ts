import { z } from "zod";

export const copyBrowserConfigSchema = z.object({
  sourceServerId: z.string().cuid(),
  targetServerId: z.string().cuid(),
});

export type CopyBrowserConfigInput = z.infer<typeof copyBrowserConfigSchema>;
