import { z } from "zod";

export const diffBrowserConfigSchema = z.object({
  serverIdA: z.string().cuid(),
  serverIdB: z.string().cuid(),
});

export type DiffBrowserConfigInput = z.infer<typeof diffBrowserConfigSchema>;
