import { z } from "zod";

export const testMcpServerSchema = z.object({
  serverId: z.string().cuid(),
});

export type TestMcpServerInput = z.infer<typeof testMcpServerSchema>;
