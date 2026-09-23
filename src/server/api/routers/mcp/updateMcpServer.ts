import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { encrypt } from "~/lib/crypto";
import { assertSafeMcpUrl } from "~/lib/mcp-url";
import { validateDedicatedProfileDir } from "~/server/lib/browser/profile-guard";
import { invalidateMcpClient } from "~/server/clients/mcp";
import { updateMcpServerSchema } from "./updateMcpServer.schema";

export const updateMcpServer = protectedProcedure
  .input(updateMcpServerSchema)
  .mutation(async ({ ctx, input }) => {
    const existing = await db.mcpServer.findUnique({ where: { id: input.serverId }, include: { instance: true } });
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
    if (existing.instance.userId !== ctx.session.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Not your instance" });

    const data: Record<string, unknown> = {};
    if (input.label !== undefined) data.label = input.label;
    if (input.url !== undefined) {
      try {
        assertSafeMcpUrl(input.url);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: (e as Error).message });
      }
      data.url = input.url;
      data.status = "unknown";
      data.needsSync = true;
      data.lastError = null;
    }
    if (input.headers !== undefined) {
      if (input.headers === null) data.headersEnc = null;
      else data.headersEnc = await encrypt(JSON.stringify(input.headers));
    }
    // Policy fields: any change restarts the supervised browser via the daemon.
    let policyTouched = false;
    if (input.userDataDir !== undefined && input.userDataDir !== null) {
      const check = validateDedicatedProfileDir(input.userDataDir);
      if (!check.ok) throw new TRPCError({ code: "BAD_REQUEST", message: check.message });
    }
    for (const key of [
      "originMode",
      "serverType",
      "browserMode",
      "browserChannel",
      "executablePath",
      "userDataDir",
      "cdpEndpoint",
      "cdpConfirmed",
      "extensionConfirmed",
      "headless",
      "noSandbox",
      "infraSeedEnabled",
      "infraSeedExcluded",
    ] as const) {
      if (input[key] !== undefined) {
        data[key] = input[key];
        policyTouched = true;
      }
    }
    if (policyTouched) data.policyVersion = { increment: 1 };

    const updated = await db.mcpServer.update({ where: { id: input.serverId }, data });
    invalidateMcpClient(input.serverId);
    return updated;
  });
