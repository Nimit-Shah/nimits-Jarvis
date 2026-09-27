import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { encrypt } from "~/lib/crypto";
import { assertSafeMcpUrl, classifyReachability } from "~/lib/mcp-url";
import { validateDedicatedProfileDir } from "~/server/lib/browser/profile-guard";
import { findTargetConflict } from "~/server/lib/browser/dedication";
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
    // Flipping to playwright enrolls the row in daemon supervision, which
    // only manages local children — refuse remote URLs with an actionable
    // message instead of a child that can never start.
    if (input.serverType === "playwright" && existing.serverType !== "playwright") {
      let reach: string;
      try {
        reach = classifyReachability(existing.url);
      } catch {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Server URL is not a valid http(s) URL." });
      }
      if (reach !== "loopback") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Browser servers must be loopback URLs — the daemon only supervises local children.",
        });
      }
    }
    if (input.url !== undefined) {
      try {
        assertSafeMcpUrl(input.url, { allowLoopback: true });
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
    // CDP ceiling: a mode the ceiling forbids cannot be selected.
    if (input.browserMode === "cdp" && input.cdpAllowed !== true && existing.cdpAllowed !== true) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Live attach is not enabled for this project. Enable it outside the Browser tab first.",
      });
    }
    // Typed consent: exact match sets cdpConfirmed; anything else refuses.
    if (input.cdpConfirmPhrase !== undefined) {
      if (input.cdpConfirmPhrase !== "ATTACH") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Type ATTACH verbatim to confirm live attach." });
      }
      if (existing.cdpAllowed !== true && input.cdpAllowed !== true) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Live attach is not enabled for this project. Enable it outside the Browser tab first.",
        });
      }
      data.cdpConfirmed = true;
      policyTouched = true;
    }
    // Endpoint change resets consent — re-confirmation is per-endpoint.
    // A valid phrase in the SAME call confirms the new endpoint directly.
    if (
      input.cdpEndpoint !== undefined &&
      input.cdpEndpoint !== existing.cdpEndpoint &&
      input.cdpConfirmPhrase !== "ATTACH"
    ) {
      data.cdpConfirmed = false;
      policyTouched = true;
    }
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
      "cdpAllowed",
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
    if (input.dismissTypeConfirmation === true) data.needsTypeConfirmation = false;
    if (input.serverType === "playwright") data.needsTypeConfirmation = false;

    // F3 — leaving a mode drops its consent: confirmation flags are
    // per-mode opt-ins, so residue must never survive a switch (a flip back
    // would otherwise skip re-confirmation). Leaving wins over an explicit
    // flag in the same call. Paths (executablePath, cdpEndpoint, …) are
    // inert off-mode and retained deliberately. No version bump: the flags
    // are unread outside their own mode.
    if (input.browserMode !== undefined && input.browserMode !== existing.browserMode) {
      if (existing.browserMode === "extension" && input.browserMode !== "extension") {
        data.extensionConfirmed = false;
      }
      if (existing.browserMode === "cdp" && input.browserMode !== "cdp") {
        data.cdpConfirmed = false;
      }
    }
    // Dedication guard: one row per target. Checked when the write could
    // change the row's target (flip or target fields) — unrelated edits on
    // legacy-violating rows stay editable; the daemon fails those closed.
    {
      const mergedServerType = input.serverType ?? existing.serverType;
      const targetAffecting =
        input.serverType !== undefined ||
        input.browserMode !== undefined ||
        input.url !== undefined ||
        input.cdpEndpoint !== undefined;
      if (mergedServerType === "playwright" && targetAffecting) {
        const conflict = await findTargetConflict({
          browserMode: input.browserMode ?? existing.browserMode,
          url: input.url ?? existing.url,
          cdpEndpoint: input.cdpEndpoint ?? existing.cdpEndpoint,
          excludeId: input.serverId,
        });
        if (conflict) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              `Target ${conflict.target} is already used by "${conflict.name}" (project "${conflict.instanceName}") — ` +
              `dedication requires one row per target. Point this row at a free port (or a free CDP endpoint) instead.`,
          });
        }
      }
    }

    const updated = await db.mcpServer.update({ where: { id: input.serverId }, data });
    invalidateMcpClient(input.serverId);
    return { ...updated };
  });
