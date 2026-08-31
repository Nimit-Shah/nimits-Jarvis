import { protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/clients/db";
import { isTelegramConfigured } from "~/server/clients/telegram";
import { decrypt } from "~/lib/crypto";
import { getInstanceInput } from "./getInstance.schema";
import { getInstanceForUser, listInstancesForUser } from "./utils";
import { DEFAULT_TIMEZONE } from "~/lib/timezone";

export const getInstance = protectedProcedure
  .input(getInstanceInput)
  .query(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;

    const [resolved, instances, onboardingState, user] = await Promise.all([
      getInstanceForUser(userId, input?.instanceId),
      listInstancesForUser(userId),
      db.onboardingState.findUnique({
        where: { userId },
        select: {
          currentStep: true,
          name: true,
          writingStyle: true,
          personality: true,
          emoji: true,
          lore: true,
          anthropicModel: true,
        },
      }),
      db.user.findUnique({
        where: { id: userId },
        select: { timezone: true },
      }),
    ]);

    // Fetch the full instance details using the resolved id
    const instance = await db.composioClawInstance.findUnique({
      where: { id: resolved.id },
      select: {
        id: true,
        userId: true,
        name: true,
        composioApiKey: true,
        composioProjectId: true,
        anthropicModel: true,
        piiRedactionEnabled: true,
        openRouterGatewayEnabled: true,
        sttModel: true,
        sttProvider: true,
        ttsProvider: true,
        ttsVoice: true,
        voiceStyle: true,
        telegramChatId: true,
        telegramLinkToken: true,
        telegramLinkTokenExpiresAt: true,
        soulPrompt: true,
        identityPrompt: true,
        userPrompt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!instance) {
      return {
        instance: null,
        instances,
        onboardingState: onboardingState ?? null,
        timezone: user?.timezone ?? DEFAULT_TIMEZONE,
        telegramConfigured: isTelegramConfigured(),
      };
    }

    let updatedName = instance.name;
    let updatedProjectId = instance.composioProjectId;
    let dbUpdated = false;

    // Resolve project ID and project display name from Composio if not already cached
    if (!instance.composioProjectId || instance.name === "Default") {
      try {
        const decryptedApiKey = instance.composioApiKey
          ? await decrypt(instance.composioApiKey)
          : null;
        const apiKey = decryptedApiKey ?? process.env.COMPOSIO_API_KEY;

        if (apiKey) {
          // 1. Fetch project ID via realtime credentials
          const credsRes = await fetch(
            "https://backend.composio.dev/api/v3/internal/sdk/realtime/credentials",
            {
              headers: {
                "x-api-key": apiKey,
                "Content-Type": "application/json",
              },
            },
          );
          if (credsRes.ok) {
            const creds = await credsRes.json();
            if (creds?.project_id) {
              updatedProjectId = creds.project_id;
              dbUpdated = true;
            }
          }

          // 2. Fetch project display name via project config
          const configRes = await fetch(
            "https://backend.composio.dev/api/v3/org/project/config",
            {
              headers: {
                "x-api-key": apiKey,
                "Content-Type": "application/json",
                "User-Agent":
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              },
            },
          );
          if (configRes.ok) {
            const config = await configRes.json();
            if (config?.display_name) {
              updatedName = config.display_name;
              dbUpdated = true;
            }
          }
        }
      } catch (e) {
        console.error(
          "Failed to dynamically fetch project details from Composio:",
          e,
        );
      }
    }

    // Persist changes to database if resolved
    if (dbUpdated) {
      await db.composioClawInstance.update({
        where: { id: instance.id },
        data: {
          name: updatedName,
          composioProjectId: updatedProjectId,
        },
      });
      // Update returned instance values
      instance.name = updatedName;
      instance.composioProjectId = updatedProjectId;

      // Update name in local instances list for selector dropdown
      const targetIdx = instances.findIndex((i) => i.id === instance.id);
      if (targetIdx !== -1) {
        instances[targetIdx] = {
          ...instances[targetIdx]!,
          name: updatedName,
          composioProjectId: updatedProjectId,
        };
      }
    }

    // Omit sensitive composioApiKey field before returning to client
    const { composioApiKey, ...safeInstance } = instance;

    return {
      instance: safeInstance,
      instances,
      onboardingState: onboardingState ?? null,
      timezone: user?.timezone ?? DEFAULT_TIMEZONE,
      telegramConfigured: isTelegramConfigured(),
    };
  });
