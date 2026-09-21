import type { RouterOutputs } from "~/clients/trpc";

export type McpServerSummary = RouterOutputs["mcp"]["listMcpServers"][number];

export type McpToolSummary = RouterOutputs["mcp"]["listMcpTools"][number];
