import { z } from "zod";
import { zodSchema } from "ai";
import type { Tool } from "ai";
import { db } from "~/server/clients/db";

/**
 * read_tool_result (docs/TOKEN_EFFICIENCY.md §4.2) — makes EVERY reduction in
 * reduce.ts addressable: a reduced history entry names its callId, and this
 * tool returns the stored full payload, with paging for array payloads.
 *
 * Scope check: rows are read back only for the calling instance.
 * PII: the returned payload is the stored (real) value; the standard tool
 * wrapper redacts it before the model sees it, exactly like any other tool.
 */

const MAX_PAGE_LIMIT = 50;

export const readToolResultSchema = z.object({
  callId: z
    .string()
    .describe("Tool-call id referenced in the reduction marker"),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Skip this many array items"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(20)
    .describe("Max array items to return"),
});

export type ReadToolResultInput = z.infer<typeof readToolResultSchema>;

export function createReadToolResultTool(
  instanceId: string,
): Tool<ReadToolResultInput, Record<string, unknown>> {
  return {
    description:
      "Fetch the full stored result of a previous tool call by its callId. Use when a marker in history says a result was reduced or omitted.",
    inputSchema: zodSchema(readToolResultSchema),
    execute: async ({ callId, offset = 0, limit = 20 }) => {
      const row = await db.toolResult.findUnique({
        where: { callId },
        select: { payload: true, instanceId: true, toolName: true },
      });
      if (!row) {
        return {
          error: {
            code: "NOT_FOUND",
            message: `No stored result for callId "${callId}". Results are persisted once a run completes; if this is from the current run, retry on the next step.`,
          },
        };
      }
      if (row.instanceId !== instanceId) {
        return {
          error: {
            code: "FORBIDDEN",
            message: "Result belongs to another project.",
          },
        };
      }

      if (Array.isArray(row.payload)) {
        const items = row.payload.slice(offset, offset + limit);
        const hasMore = offset + items.length < row.payload.length;
        return {
          callId,
          toolName: row.toolName,
          items,
          total: row.payload.length,
          returned: items.length,
          offset,
          truncated: hasMore,
          hint: hasMore
            ? `read_tool_result(callId="${callId}", offset=${offset + items.length})`
            : undefined,
        };
      }

      return {
        callId,
        toolName: row.toolName,
        value: row.payload,
      };
    },
  };
}
