import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { encrypt } from "~/lib/crypto";
import { TRPCError } from "@trpc/server";
import { updateSettingsInput } from "./updateSettings.schema";
import { getInstanceForUser } from "./utils";
import { resolveSafePath } from "~/server/lib/fs-access/paths";

export const updateSettings = protectedProcedure
  .input(updateSettingsInput)
  .mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;

    // Ownership-checked instance resolution
    const instance = await getInstanceForUser(userId, input.instanceId);

    // Validate fsRootPath against the path-safety boundary here (async realpath —
    // can't live in the sync Zod schema). Empty/null clears back to home dir.
    let fsRootPath: string | null | undefined;
    if (input.fsRootPath !== undefined) {
      if (input.fsRootPath === null || input.fsRootPath.trim() === "") {
        fsRootPath = null;
      } else {
        const safe = await resolveSafePath(input.fsRootPath);
        if (!safe.ok) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Invalid root folder: ${safe.message}`,
          });
        }
        fsRootPath = safe.path;
      }
    }

    // Encrypt per-project API key before storing
    const encryptedApiKey = input.composioApiKey
      ? await encrypt(input.composioApiKey)
      : undefined;

    const [updated] = await db.$transaction([
      db.composioClawInstance.update({
        where: { id: instance.id },
        data: {
          ...(input.name && { name: input.name }),
          ...(encryptedApiKey !== undefined && {
            composioApiKey: encryptedApiKey,
            composioProjectId: null,
          }),
          ...(input.anthropicModel && { anthropicModel: input.anthropicModel }),
          ...(input.piiRedactionEnabled !== undefined && {
            piiRedactionEnabled: input.piiRedactionEnabled,
          }),
          ...(input.openRouterGatewayEnabled !== undefined && {
            openRouterGatewayEnabled: input.openRouterGatewayEnabled,
          }),
          ...(input.sttModel && { sttModel: input.sttModel }),
          ...(input.ttsProvider && { ttsProvider: input.ttsProvider }),
          ...(input.ttsVoice && { ttsVoice: input.ttsVoice }),
          ...(input.voiceStyle !== undefined && { voiceStyle: input.voiceStyle }),
          ...(input.fsReadEnabled !== undefined && { fsReadEnabled: input.fsReadEnabled }),
          ...(input.fsWriteAllowed !== undefined && { fsWriteAllowed: input.fsWriteAllowed }),
          ...(input.fsRootPath !== undefined && {
            fsRootPath, // validated above (null | realpathed string)
          }),
        },
        select: {
          id: true,
          name: true,
          anthropicModel: true,
          piiRedactionEnabled: true,
          openRouterGatewayEnabled: true,
          sttModel: true,
          ttsProvider: true,
          ttsVoice: true,
          voiceStyle: true,
          fsReadEnabled: true,
          fsWriteAllowed: true,
          fsRootPath: true,
          updatedAt: true,
        },
      }),
      ...(input.timezone
        ? [
            db.user.update({
              where: { id: userId },
              data: { timezone: input.timezone },
            }),
          ]
        : []),
    ]);

    return updated;
  });
