import { z } from "zod";

export const getDiscoverInput = z.object({});

export type GetDiscoverInput = z.infer<typeof getDiscoverInput>;
