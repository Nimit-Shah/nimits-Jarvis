import { auth } from "~/server/auth";
import { env } from "~/env";
import { db } from "~/server/clients/db";

/**
 * POST /api/transcribe
 *
 * Authenticated proxy to the local Whisper STT server.
 * Accepts multipart/form-data with an `audio` file field.
 * Returns { text: string } or a structured error.
 *
 * Audio never leaves the local network — the Whisper server runs
 * on the user's machine at WHISPER_BASE_URL.
 */
export async function POST(request: Request) {
  // 1. Authenticate
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
  }

  // 2. Parse the incoming audio blob
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Invalid form data", code: "BAD_REQUEST" }, { status: 400 });
  }

  const audio = form.get("audio");
  if (!audio || !(audio instanceof Blob)) {
    return Response.json({ error: "Missing audio field", code: "BAD_REQUEST" }, { status: 400 });
  }

  // 3. Resolve STT target — local Whisper vs OpenRouter cloud (official pages:
  // https://openrouter.ai/collections/speech-to-text-models & /docs/guides/overview/multimodal/stt)
  // Grouped in settings: Local (tiny/base/small/medium/large-v3) default small (English)
  // vs OpenRouter (openai/whisper-1, gpt-4o-transcribe, etc. via /api/v1/audio/transcriptions)
  // No language switch in v1 — always "en" default.

  const modelOverride = form.get("model");
  const languageOverride = form.get("language");
  const instanceIdField = form.get("instanceId");

  let model = typeof modelOverride === "string" && modelOverride.trim() ? modelOverride.trim() : env.WHISPER_MODEL;
  let language = typeof languageOverride === "string" && languageOverride.trim() ? languageOverride.trim() : undefined;
  // v1: lock to English (no UI), but still accept explicit "en" if sent
  if (!language) language = "en";

  if ((!modelOverride || !String(modelOverride).trim()) && instanceIdField && typeof instanceIdField === "string") {
    try {
      const inst = await db.composioClawInstance.findFirst({
        where: { id: instanceIdField, userId: session.user.id },
        select: { sttModel: true },
      });
      if (inst?.sttModel) model = inst.sttModel;
    } catch {}
  } else if (!modelOverride || !String(modelOverride).trim()) {
    try {
      const inst = await db.composioClawInstance.findFirst({
        where: { userId: session.user.id },
        orderBy: { createdAt: "asc" },
        select: { sttModel: true },
      });
      if (inst?.sttModel) model = inst.sttModel;
    } catch {}
  }

  const isOpenRouterStt = model.includes("/");
  // allowlist per official OpenRouter collections + local sizes
  const OPENROUTER_STT_ALLOW = new Set([
    "openai/whisper-1",
    "openai/whisper-large-v3",
    "openai/gpt-4o-transcribe",
    "openai/gpt-4o-mini-transcribe",
    "openai/gpt-transcribe",
    "mistralai/voxtral-mini-transcribe",
    "mistralai/voxtral-small-24b-2507-stt",
    "qwen/qwen3-asr-0.6b",
    "qwen/qwen3-asr-1.7b",
    "fish-audio/transcribe-1",
    "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b",
  ]);
  // Local whisper ids — same set env.ts validates, including WhisperKit argmax ids
  const LOCAL_STT_ALLOW = /^(tiny|tiny\.en|base|base\.en|small|small\.en|medium|medium\.en|large-v3|large-v3-turbo|large-v3-v20240930_626MB|large-v3-v20240930_turbo)$/;
  if (isOpenRouterStt && !OPENROUTER_STT_ALLOW.has(model)) {
    return Response.json({ error: `Unsupported STT model ${model}. See https://openrouter.ai/collections/speech-to-text-models`, code: "BAD_MODEL" }, { status: 400 });
  }
  if (!isOpenRouterStt && !LOCAL_STT_ALLOW.test(model)) {
    return Response.json({ error: `Unsupported local STT model ${model}`, code: "BAD_MODEL" }, { status: 400 });
  }

  // OpenRouter cloud path: POST https://openrouter.ai/api/v1/audio/transcriptions
  // with {input_audio: {data: base64, format: wav}, model, language}
  // Otherwise local whisper path: multipart file to WHISPER_BASE_URL/v1/audio/transcriptions
  if (isOpenRouterStt) {
    if (!env.OPENROUTER_API_KEY) {
      return Response.json({ error: "OPENROUTER_API_KEY not set for cloud STT", code: "STT_UNCONFIGURED" }, { status: 503 });
    }
    const arrayBuf = await audio.arrayBuffer();
    const b64 = Buffer.from(arrayBuf).toString("base64");
    const fmt = (audio as any).type?.includes("webm") ? "webm" : (audio as any).type?.includes("mp3") ? "mp3" : "wav";
    const orRes = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.NEXT_PUBLIC_APP_URL,
        "X-Title": "Nimits-Jarvis",
      },
      body: JSON.stringify({ model, input_audio: { data: b64, format: fmt }, language }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!orRes.ok) {
      const txt = await orRes.text().catch(() => "");
      console.error("OpenRouter STT", orRes.status, txt);
      return Response.json({ error: `OpenRouter STT ${orRes.status}: ${txt || orRes.statusText}`, code: "TRANSCRIPTION_FAILED" }, { status: 502 });
    }
    const orJson = (await orRes.json()) as { text?: string };
    const text = typeof orJson.text === "string" ? orJson.text : "";
    return Response.json({ text });
  }

  const whisperForm = new FormData();
  whisperForm.append("file", audio, "recording.wav");
  whisperForm.append("model", model);
  if (language) whisperForm.append("language", language);

  let whisperRes: Response;
  try {
    whisperRes = await fetch(`${env.WHISPER_BASE_URL}/v1/audio/transcriptions`, {
      method: "POST",
      body: whisperForm,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    return Response.json(
      {
        error: isTimeout ? "Whisper server timed out" : "Whisper server is unreachable",
        code: "WHISPER_UNAVAILABLE",
      },
      { status: 503 },
    );
  }

  if (!whisperRes.ok) {
    let errBody = "";
    try {
      errBody = await whisperRes.text();
    } catch {}
    console.error("Whisper server error status:", whisperRes.status, "Body:", errBody);
    return Response.json(
      { error: `Whisper transcription failed: ${errBody || whisperRes.statusText}`, code: "TRANSCRIPTION_FAILED" },
      { status: 500 },
    );
  }

  // 4. Return the transcription text
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await whisperRes.json();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const text = typeof result?.text === "string" ? result.text : "";
  return Response.json({ text });
}
