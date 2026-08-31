import { auth } from "~/server/auth";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, unlink, writeFile } from "fs/promises";
import { env } from "~/env";
import { db } from "~/server/clients/db";

const execFileAsync = promisify(execFile);

// ── OpenRouter TTS (default — Fish via OpenRouter, no separate key) ──────────
// Official endpoint: POST https://openrouter.ai/api/v1/audio/speech
//   { model, input, voice?, response_format } → raw audio byte stream (mp3/pcm)
// Uses the existing OPENROUTER_API_KEY — Fish Audio S2.1 Pro Free is the free
// default; other OR speech models (OpenAI/Gemini/Kokoro) are dropdown backups.
// Falls back to local-mac `say` on any failure. Timeout 8s: a hanging upstream
// must not stall a spoken sentence (Bug-6 discipline).

const OPENROUTER_TTS_TIMEOUT_MS = 15_000; // bounded; Kokoro needs >8s cold, Fish ~2s

// Allowlist + per-model contract — verified live against OpenRouter
// (GET /api/v1/models?output_modalities=speech + probe POSTs).
// voice: explicit voice REQUIRED for some providers (OpenRouter 400s otherwise).
// format "pcm" (Gemini) returns raw 24kHz 16-bit mono — wrapped into a WAV
// header server-side so the browser <audio> element can play it.
const OR_TTS_MODELS: Record<string, { format: "mp3" | "pcm"; defaultVoice?: string; sampleRate?: number }> = {
  "fish-audio/s2.1-pro-free:free": { format: "mp3" },                      // free default — 0.7s (verified)
  "fish-audio/s2.1-pro": { format: "mp3" },                                // paid production
  "deepgram/flux-tts:free": { format: "mp3", defaultVoice: "flux-alexis-en" }, // free backup — 1.9s (verified)
  "google/gemini-3.1-flash-tts-preview": { format: "pcm", defaultVoice: "Puck", sampleRate: 24000 }, // backup — 2.8s (verified)
  // hexgrad/kokoro-82m dropped: 28s per sentence via OpenRouter — unusable in a voice loop
};

const OPENROUTER_TTS_ALLOW = new Set(Object.keys(OR_TTS_MODELS));

// Legacy voice ids (pre-OpenRouter defaults) → OR fish free model
const LEGACY_FISH_VOICES: Record<string, string> = {
  "s1-pro": "fish-audio/s2.1-pro-free:free",
  s1: "fish-audio/s2.1-pro-free:free",
  "s2.1-pro-free": "fish-audio/s2.1-pro-free:free",
  "s1-mini": "fish-audio/s2.1-pro-free:free",
  "s2.1-pro": "fish-audio/s2.1-pro",
};

/** Resolve a voice id (possibly "<model>::<voice>") into {model, voice?, format, sampleRate} */
function resolveOrTts(voiceId: string): { model: string; voice?: string; format: "mp3" | "pcm"; sampleRate?: number } | null {
  const legacy = LEGACY_FISH_VOICES[voiceId];
  if (legacy) {
    const cfg = OR_TTS_MODELS[legacy]!;
    return { model: legacy, format: cfg.format, sampleRate: cfg.sampleRate };
  }
  const [rawModel, voiceOverride] = voiceId.split("::");
  const model = rawModel?.trim();
  if (!model) return null;
  const cfg = OR_TTS_MODELS[model];
  if (!cfg) return null;
  const voice = voiceOverride?.trim() || cfg.defaultVoice;
  return { model, voice, format: cfg.format, sampleRate: cfg.sampleRate };
}

/**
 * Fish models steer style via PARENTHETICAL CONTROLS INLINE IN THE TEXT
 * (per OpenRouter model description: "using parenthetical controls to guide
 * speaking style") — the `voice` param expects a voice id, NOT free text
 * (verified: free-text voice → provider 400). So the pinned style is prefixed
 * to the input text instead. Preset-voice providers (Deepgram/Gemini) ignore it.
 */
function applyVoiceStyle(
  resolved: { model: string; voice?: string; format: "mp3" | "pcm"; sampleRate?: number },
  voiceStyle: string | undefined,
  text: string,
): { model: string; voice?: string; format: "mp3" | "pcm"; sampleRate?: number; input: string } {
  const style = voiceStyle?.trim();
  if (!style || !resolved.model.startsWith("fish-audio/")) {
    return { ...resolved, input: text };
  }
  // Strip an existing style prefix so repeated calls don't stack styles
  const clean = text.replace(/^\([^)]{0,300}\)\s*/, "");
  return { ...resolved, input: `(${style}) ${clean}` };
}

/** Wrap raw 16-bit mono PCM into a minimal WAV container (44-byte header). */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);        // PCM
  header.writeUInt16LE(1, 22);        // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);        // block align
  header.writeUInt16LE(16, 34);       // bits
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function generateOpenRouterTts(
  text: string,
  voiceId: string,
  voiceStyle?: string,
): Promise<{ buffer: Buffer; model: string; contentType: string }> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const base = resolveOrTts(voiceId);
  if (!base) throw new Error(`Unsupported OpenRouter TTS voice "${voiceId}"`);
  const resolved = applyVoiceStyle(base, voiceStyle, text);
  if (resolved.format === "pcm" && !resolved.voice) {
    throw new Error(`Voice is required for ${resolved.model}`);
  }

  const res = await fetch("https://openrouter.ai/api/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": env.NEXT_PUBLIC_APP_URL,
      "X-Title": "Nimits-Jarvis",
    },
    body: JSON.stringify({
      model: resolved.model,
      input: resolved.input,
      ...(resolved.voice ? { voice: resolved.voice } : {}),
      response_format: resolved.format,
    }),
    signal: AbortSignal.timeout(OPENROUTER_TTS_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter TTS ${res.status}: ${body || res.statusText}`);
  }

  const arr = await res.arrayBuffer();
  let buffer: Buffer = Buffer.from(arr) as Buffer<ArrayBuffer>;
  let contentType = "audio/mpeg";
  if (resolved.format === "pcm") {
    buffer = pcmToWav(buffer, resolved.sampleRate ?? 24000);
    contentType = "audio/wav";
  }
  return { buffer, model: resolved.model, contentType };
}

// ── Local macOS `say` — single process, WAV out (no afconvert hop) ───────────

async function generateLocalMac(text: string): Promise<Buffer> {
  const id = randomUUID();
  const textPath = `/tmp/jarvis-tts-${id}.txt`;
  const wavPath = `/tmp/jarvis-tts-${id}.wav`;
  try {
    await writeFile(textPath, text, "utf-8");
    await execFileAsync(
      "say",
      ["-v", "Daniel (Enhanced)", "-f", textPath, "-o", wavPath, "--file-format=WAVE", "--data-format=LEI16@22050"],
      { timeout: 30_000 },
    );
    return await readFile(wavPath);
  } finally {
    await Promise.allSettled([unlink(textPath), unlink(wavPath)]);
  }
}

/**
 * POST /api/tts
 *
 * Provider resolution: body {provider, voice} > instance (ttsProvider/ttsVoice)
 * > env (TTS_PROVIDER/TTS_VOICE).
 * - "fish-audio" | "openrouter" → OpenRouter /api/v1/audio/speech (free Fish S2.1
 *   Pro default; Gemini/OpenAI/Kokoro as dropdown backups) — reuses OPENROUTER_API_KEY,
 *   no separate Fish key.
 * - "local-mac" | "piper"(alias) → macOS `say` single-process WAV fallback.
 *
 * X-TTS-Provider header reports the engine that actually spoke
 * ("openrouter:<model>" or "local-mac") so the client can badge fallbacks.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let text: string;
  let requestedVoice: string | undefined;
  let requestedProvider: string | undefined;
  let requestedVoiceStyle: string | undefined;
  try {
    const body = (await request.json()) as { text?: string; voice?: string; provider?: string; voiceStyle?: string };
    text = typeof body.text === "string" ? body.text.trim() : "";
    requestedVoice = typeof body.voice === "string" ? body.voice.trim() : undefined;
    requestedProvider = typeof body.provider === "string" ? body.provider.trim() : undefined;
    requestedVoiceStyle = typeof body.voiceStyle === "string" ? body.voiceStyle.trim() : undefined;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!text) return Response.json({ error: "Missing text field" }, { status: 400 });
  if (text.length > 5000) text = text.slice(0, 5000);

  // Resolve provider/voice/style: body > instance > env defaults (per-project dropdown)
  let provider: string = requestedProvider ?? env.TTS_PROVIDER;
  let voice: string = requestedVoice ?? env.TTS_VOICE;
  let voiceStyle: string = requestedVoiceStyle ?? "";
  try {
    const url = new URL(request.url);
    const instanceId = url.searchParams.get("instanceId");
    if (!requestedVoice || !requestedProvider || !requestedVoiceStyle) {
      const where = instanceId ? { id: instanceId, userId: session.user.id } : { userId: session.user.id };
      const inst = await db.composioClawInstance.findFirst({
        where,
        orderBy: instanceId ? undefined : { createdAt: "asc" },
        select: { ttsProvider: true, ttsVoice: true, voiceStyle: true },
      });
      if (inst) {
        if (!requestedProvider && inst.ttsProvider) provider = inst.ttsProvider;
        if (!requestedVoice && inst.ttsVoice) voice = inst.ttsVoice;
        if (requestedVoiceStyle === undefined && inst.voiceStyle) voiceStyle = inst.voiceStyle;
      }
    }
  } catch {
    // ignore — fall back to env
  }

  const useOpenRouter = provider === "fish-audio" || provider === "openrouter";
  if (provider === "piper") provider = "local-mac"; // piper alias: latency-problematic, local fallback

  try {
    if (useOpenRouter) {
      try {
        const { buffer, model, contentType } = await generateOpenRouterTts(text, voice, voiceStyle);
        return new Response(buffer as unknown as BodyInit, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Content-Length": buffer.length.toString(),
            "Cache-Control": "no-store",
            "X-TTS-Provider": `openrouter:${model}`,
          },
        });
      } catch (e) {
        // Must be visible in prod — a degraded upstream otherwise reads as "slow".
        console.error("[TTS] OpenRouter TTS failed, falling back to local-mac:", e);
      }
    }

    const wavBuffer = await generateLocalMac(text);
    return new Response(wavBuffer as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": wavBuffer.length.toString(),
        "Cache-Control": "no-store",
        "X-TTS-Provider": "local-mac",
      },
    });
  } catch (err) {
    console.error("[TTS] Error:", err);
    return Response.json({ error: "Text-to-speech generation failed" }, { status: 500 });
  }
}
