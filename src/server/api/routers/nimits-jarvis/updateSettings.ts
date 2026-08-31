import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { encrypt } from "~/lib/crypto";
import { updateSettingsInput } from "./updateSettings.schema";
import { getInstanceForUser } from "./utils";

export const updateSettings = protectedProcedure
  .input(updateSettingsInput)
  .mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;

    // Ownership-checked instance resolution
    const instance = await getInstanceForUser(userId, input.instanceId);

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
