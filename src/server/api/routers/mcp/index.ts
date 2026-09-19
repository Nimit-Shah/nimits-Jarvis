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
import { listMcpOriginRules } from "./listMcpOriginRules";
import { addMcpOriginRule } from "./addMcpOriginRule";
import { toggleMcpOriginRule } from "./toggleMcpOriginRule";
import { deleteMcpOriginRule } from "./deleteMcpOriginRule";
import { listSeedCandidates } from "./listSeedCandidates";

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
  listMcpOriginRules,
  addMcpOriginRule,
  toggleMcpOriginRule,
  deleteMcpOriginRule,
  listSeedCandidates,
});
