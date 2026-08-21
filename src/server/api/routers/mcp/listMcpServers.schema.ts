import { z } from "zod";

export const listMcpServersSchema = z.object({
  instanceId: z.string().cuid(),
});

export type ListMcpServersInput = z.infer<typeof listMcpServersSchema>;
