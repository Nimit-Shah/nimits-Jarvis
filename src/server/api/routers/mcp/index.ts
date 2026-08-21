import { router } from "~/server/api/trpc";
import { addMcpServer } from "./addMcpServer";
import { listMcpServers } from "./listMcpServers";
import { listMcpTools } from "./listMcpTools";
import { updateMcpServer } from "./updateMcpServer";
import { deleteMcpServer } from "./deleteMcpServer";
import { toggleMcpServer } from "./toggleMcpServer";
import { syncMcpTools } from "./syncMcpTools";
import { toggleMcpTool } from "./toggleMcpTool";
import { testMcpServer } from "./testMcpServer";

export const mcpRouter = router({
  addMcpServer,
  listMcpServers,
  listMcpTools,
  updateMcpServer,
  deleteMcpServer,
  toggleMcpServer,
  syncMcpTools,
  toggleMcpTool,
  testMcpServer,
});
