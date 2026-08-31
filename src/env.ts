import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

const booleanString = z.preprocess(
  (val) => (val === "true" ? true : val === "false" ? false : val),
  z.boolean(),
);

export const env = createEnv({
  server: {
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    // Better Auth
    BETTER_AUTH_SECRET: z.string(),

    // Composio API (global key)
    COMPOSIO_API_KEY: z.string(),

    // Encryption key for at-rest per-project Composio API keys (optional — only required when per-project keys are used)
    // Generate with: openssl rand -hex 32
    ENCRYPTION_KEY: z.string().optional(),

    // Telegram bot (optional - Telegram features disabled when missing)
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_BOT_USERNAME: z.string().optional(),
    TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

    // Database
    DATABASE_URL: z.string().url(),

    // Redis (optional - resumable streams disabled when missing; basic streaming still works)
    REDIS_URL: z.string().optional(),

    // Agent entrypoint rate limits
    RATE_LIMIT_CHAT_PER_MINUTE: z.coerce.number().int().positive().default(20),
    RATE_LIMIT_CHAT_PER_DAY: z.coerce.number().int().positive().default(500),
    RATE_LIMIT_CRON_PER_DAY: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_TELEGRAM_PER_MINUTE: z.coerce
      .number()
      .int()
      .positive()
      .default(20),
    RATE_LIMIT_FAIL_MODE: z.enum(["open", "closed"]).default("open"),
    RATE_LIMIT_ENABLED: booleanString.default(true),

    // Cron auth. Required in production so unauthenticated callers can't hit
    // /api/cron/* endpoints. Vercel auto-injects this when crons are configured
    // in vercel.json; the nimits-jarvis deploy CLI also generates one on first deploy.
    CRON_SECRET: z.string(),

    // Ollama (local)
    OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),

    // OpenRouter (optional)
    OPENROUTER_API_KEY: z.string().optional(),

    // Whisper local STT (optional — voice mode disabled when missing)
    // v1 default `small` for latency on 16GB M2. Validated against known
    // whisper.cpp / WhisperKit (argmax) ids — note the underscore in
    // `large-v3-v20240930_626MB` (a WhisperKit model identifier, not a size).
    // Verify against the running server:
    //   curl -F file=@sample.wav -F model=small $WHISPER_BASE_URL/v1/audio/transcriptions
    WHISPER_BASE_URL: z.string().url().default("http://127.0.0.1:8081"),
    WHISPER_MODEL: z
      .string()
      .regex(
        /^(tiny|tiny\.en|base|base\.en|small|small\.en|medium|medium\.en|large-v3|large-v3-turbo|large-v3-v20240930_626MB|large-v3-v20240930_turbo)$/,
        "Invalid WHISPER_MODEL id (must be a whisper.cpp size or WhisperKit argmax id)",
      )
      .default("small"),
    // TTS via OpenRouter /api/v1/audio/speech — Fish S2.1 Pro Free is the free
    // default (no separate Fish key needed; reuses OPENROUTER_API_KEY).
    // "fish-audio" and "openrouter" are aliases of the same OpenRouter path.
    TTS_PROVIDER: z.enum(["fish-audio", "openrouter", "local-mac", "piper"]).default("fish-audio"),
    TTS_VOICE: z.string().default("s2.1-pro-free"),
    // Mnemosyne local sidecar
    MNEMOSYNE_URL: z.string().url().default("http://127.0.0.1:3999"),
  },
  client: {
    NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  },
  runtimeEnv: {
    // Server
    NODE_ENV: process.env.NODE_ENV,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME,
    TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    RATE_LIMIT_CHAT_PER_MINUTE: process.env.RATE_LIMIT_CHAT_PER_MINUTE,
    RATE_LIMIT_CHAT_PER_DAY: process.env.RATE_LIMIT_CHAT_PER_DAY,
    RATE_LIMIT_CRON_PER_DAY: process.env.RATE_LIMIT_CRON_PER_DAY,
    RATE_LIMIT_TELEGRAM_PER_MINUTE:
      process.env.RATE_LIMIT_TELEGRAM_PER_MINUTE,
    RATE_LIMIT_FAIL_MODE:
      process.env.RATE_LIMIT_FAIL_MODE ??
      ((process.env.NODE_ENV ?? "development") === "development"
        ? "open"
        : "closed"),
    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
    CRON_SECRET: process.env.CRON_SECRET,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    WHISPER_BASE_URL: process.env.WHISPER_BASE_URL,
    WHISPER_MODEL: process.env.WHISPER_MODEL,
    TTS_PROVIDER: process.env.TTS_PROVIDER,
    TTS_VOICE: process.env.TTS_VOICE,
    MNEMOSYNE_URL: process.env.MNEMOSYNE_URL,

    // Client URL resolution:
    //  - dev: derive from PORT so `PORT=3001 pnpm dev` just works
    //  - prod with explicit override: use NEXT_PUBLIC_APP_URL
    //  - on Vercel: fall back to the auto-injected canonical URL so self-hosters
    //    don't need to set anything (VERCEL_PROJECT_PRODUCTION_URL is the
    //    stable production domain; VERCEL_URL is the per-deployment URL)
    NEXT_PUBLIC_APP_URL:
      process.env.NODE_ENV === "development"
        ? `http://localhost:${process.env.PORT ?? "3000"}`
        : process.env.NEXT_PUBLIC_APP_URL ??
          (process.env.VERCEL_PROJECT_PRODUCTION_URL
            ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
            : process.env.VERCEL_URL
              ? `https://${process.env.VERCEL_URL}`
              : undefined),
  },
  // SKIP_ENV_VALIDATION is for local lint/typecheck without a full .env.
  // Never honour it in production — security-critical secrets like
  // CRON_SECRET and BETTER_AUTH_SECRET must always be present at runtime.
  skipValidation:
    !!process.env.SKIP_ENV_VALIDATION &&
    process.env.NODE_ENV !== "production",
  emptyStringAsUndefined: true,
});
