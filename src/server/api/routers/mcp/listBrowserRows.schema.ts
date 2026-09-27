import { z } from "zod";

export const listBrowserRowsSchema = z.object({});

export type ListBrowserRowsInput = z.infer<typeof listBrowserRowsSchema>;
