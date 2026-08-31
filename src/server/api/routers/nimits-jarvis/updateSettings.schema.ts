import { z } from "zod";
import { ALLOWED_ANTHROPIC_MODELS } from "./createInstance.schema";

const ianaTimezone = z
  .string()
  .refine(
    (tz) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid IANA timezone" },
  );

export const updateSettingsInput = z.object({
  instanceId: z.string().optional(),
  name: z.string().min(1).max(80).optional(),
  composioApiKey: z.string().optional(),
  anthropicModel: z.string().optional(),
  timezone: ianaTimezone.optional(),
  piiRedactionEnabled: z.boolean().optional(),
  openRouterGatewayEnabled: z.boolean().optional(),
  // STT: local whisper sizes + OpenRouter cloud models per https://openrouter.ai/collections/speech-to-text-models & /docs/guides/overview/multimodal/stt
  // Local: tiny|base|small|medium|large-v3|large-v3-v20240930_626MB ; Cloud: openai/whisper-1, openai/gpt-4o-transcribe, etc. validated allowlist in route.
  sttModel: z.string().min(1).max(100).optional(),
  // TTS: "fish-audio"/"openrouter" both mean OpenRouter /api/v1/audio/speech
  // (Fish S2.1 Pro Free default, no separate key); "local-mac" is the offline fallback.
  ttsProvider: z.enum(["fish-audio", "openrouter", "local-mac", "piper"]).optional(),
  ttsVoice: z.string().min(1).max(100).optional(),
  // Free-text voice steering prompt for Fish (pins the same voice take per request)
  voiceStyle: z.string().max(300).optional(),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsInput>;
