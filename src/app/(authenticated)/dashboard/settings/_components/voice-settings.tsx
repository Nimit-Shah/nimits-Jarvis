"use client";

import { useState } from "react";
import { Mic, Volume2, AudioLines } from "lucide-react";
import { trpc } from "~/clients/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";

const LOCAL_STT = [
  { value: "tiny", label: "Whisper tiny", desc: "~40MB · fastest, lower accuracy" },
  { value: "base", label: "Whisper base", desc: "~150MB · fast" },
  { value: "small", label: "Whisper small — default", desc: "~500MB · balanced · ~600ms on M2" },
  { value: "medium", label: "Whisper medium", desc: "~1.5GB · better names, slower" },
  { value: "large-v3", label: "Whisper large-v3", desc: "~3GB · best accuracy" },
  { value: "large-v3-v20240930_626MB", label: "Whisper large-v3 626MB", desc: "Legacy large" },
] as const;

const OPENROUTER_STT = [
  { value: "openai/whisper-1", label: "OpenRouter · Whisper-1", desc: "$0.006/min · 25MB · OpenAI" },
  { value: "openai/whisper-large-v3", label: "OpenRouter · Whisper large-v3", desc: "OpenAI via OpenRouter" },
  { value: "openai/gpt-4o-mini-transcribe", label: "OpenRouter · GPT-4o Mini Transcribe", desc: "$1.25/M · token-priced, high volume" },
  { value: "openai/gpt-4o-transcribe", label: "OpenRouter · GPT-4o Transcribe", desc: "$2.5/M · high quality" },
  { value: "mistralai/voxtral-mini-transcribe", label: "OpenRouter · Voxtral Mini Transcribe", desc: "$0.003/min · Mistral" },
  { value: "qwen/qwen3-asr-0.6b", label: "OpenRouter · Qwen3 ASR 0.6B", desc: "$0.000003/s · 30 languages" },
] as const;

const STT_OPTIONS = [...LOCAL_STT, ...OPENROUTER_STT] as const;

// TTS via OpenRouter /api/v1/audio/speech — "fish-audio" and "openrouter" are
// aliases of the same path; voice format "<model>::<voice>" when a voice is needed.
const OPENROUTER_TTS = [
  { value: "fish-audio:s2.1-pro-free", label: "Fish S2.1 Pro Free — default", desc: "$0 · ~0.7s · via OpenRouter · no extra key", provider: "fish-audio", voice: "s2.1-pro-free" },
  { value: "openrouter:fish-audio/s2.1-pro", label: "Fish S2.1 Pro (paid)", desc: "Production SLA · via OpenRouter", provider: "openrouter", voice: "fish-audio/s2.1-pro" },
  { value: "openrouter:deepgram/flux-tts:free", label: "Deepgram Flux TTS (free)", desc: "Free backup · ~1.9s · expressive English", provider: "openrouter", voice: "deepgram/flux-tts:free" },
  { value: "openrouter:google/gemini-3.1-flash-tts-preview", label: "Gemini 3.1 Flash TTS (preview)", desc: "Backup · ~2.8s · 70+ languages · audio tags", provider: "openrouter", voice: "google/gemini-3.1-flash-tts-preview" },
] as const;

const LOCAL_TTS = [
  { value: "local-mac:Daniel (Enhanced)", label: "Local macOS — Daniel (Enhanced)", desc: "Offline fallback · zero latency", provider: "local-mac", voice: "Daniel (Enhanced)" },
] as const;

const TTS_OPTIONS = [...OPENROUTER_TTS, ...LOCAL_TTS] as const;
const DEFAULT_TTS_KEY = "fish-audio:s2.1-pro-free";

export function VoiceSettings({
  instanceId,
  sttModel,
  ttsProvider,
  ttsVoice,
  voiceStyle,
}: {
  instanceId: string;
  sttModel: string;
  ttsProvider: string;
  ttsVoice: string;
  voiceStyle?: string;
}) {
  const utils = trpc.useUtils();
  const update = trpc.nimitsJarvis.updateSettings.useMutation({
    onSuccess: () => void utils.nimitsJarvis.getInstance.invalidate({ instanceId }),
  });

  const currentTtsKey = `${ttsProvider}:${ttsVoice}`;
  const [localStt, setLocalStt] = useState(sttModel ?? "small");
  const [localTtsKey, setLocalTtsKey] = useState(
    TTS_OPTIONS.some((o) => o.value === currentTtsKey) ? currentTtsKey : DEFAULT_TTS_KEY,
  );
  const [localVoiceStyle, setLocalVoiceStyle] = useState(voiceStyle ?? "");

  const handleSttChange = (v: string) => {
    setLocalStt(v);
    void update.mutateAsync({ instanceId, sttModel: v as any });
  };

  const handleTtsChange = (v: string) => {
    setLocalTtsKey(v);
    const opt = TTS_OPTIONS.find((o) => o.value === v);
    if (!opt) return;
    void update.mutateAsync({
      instanceId,
      ttsProvider: opt.provider as any,
      ttsVoice: opt.voice,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mic className="size-4" /> Voice Mode
        </CardTitle>
        <CardDescription>STT and TTS are separate — pick each independently. STT is local-first; TTS runs via OpenRouter (no separate key) with local fallback.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* STT */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-sm font-semibold">
            <Mic className="size-3.5" /> Voice Input (STT Model)
          </Label>
          <p className="text-muted-foreground text-xs">Whisper model used for speech→text. Small is default for latency on 16GB M2; large is more accurate on names/emails.</p>
          <Select value={localStt} onValueChange={handleSttChange} disabled={update.isPending}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={localStt} />
            </SelectTrigger>
            <SelectContent>
              <div className="px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">Local Whisper (on-device)</div>
              {LOCAL_STT.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <div className="flex flex-col text-left">
                    <span className="text-xs font-medium">{o.label}</span>
                    <span className="text-muted-foreground text-[10px]">{o.desc}</span>
                  </div>
                </SelectItem>
              ))}
              <div className="mt-1 border-t px-2 pt-1.5 text-[10px] font-semibold uppercase text-muted-foreground">OpenRouter STT (cloud, via /v1/audio/transcriptions)</div>
              {OPENROUTER_STT.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <div className="flex flex-col text-left">
                    <span className="text-xs font-medium">{o.label}</span>
                    <span className="text-muted-foreground text-[10px]">{o.desc}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-[11px]">
            Local small is default (English). Cloud via OpenRouter official STT API <code className="rounded bg-muted px-1">/api/v1/audio/transcriptions</code> — see{" "}
            <a href="https://openrouter.ai/collections/speech-to-text-models" target="_blank" rel="noreferrer" className="underline">
              collections
            </a>{" "}
            & <a href="https://openrouter.ai/docs/guides/overview/multimodal/stt" className="underline" target="_blank" rel="noreferrer">docs</a>.
          </p>
          {update.isPending && <p className="text-muted-foreground text-[11px]">Saving...</p>}
        </div>

        {/* TTS */}
        <div className="space-y-2 border-t pt-4">
          <Label className="flex items-center gap-2 text-sm font-semibold">
            <Volume2 className="size-3.5" /> Voice Output (TTS Voice)
          </Label>
          <p className="text-muted-foreground text-xs">
            Default is Fish S2.1 Pro Free via OpenRouter — no separate key, reuses{" "}
            <code className="rounded bg-muted px-1">OPENROUTER_API_KEY</code>. If local TTS can't keep up, pick an
            OpenRouter backup below; macOS Daniel is the offline fallback.
          </p>
          <Select value={localTtsKey} onValueChange={handleTtsChange} disabled={update.isPending}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <div className="px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">OpenRouter TTS (cloud — via /v1/audio/speech)</div>
              {OPENROUTER_TTS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <div className="flex flex-col text-left">
                    <span className="text-xs font-medium">{o.label}</span>
                    <span className="text-muted-foreground text-[10px]">{o.desc}</span>
                  </div>
                </SelectItem>
              ))}
              <div className="mt-1 border-t px-2 pt-1.5 text-[10px] font-semibold uppercase text-muted-foreground">Local fallback</div>
              {LOCAL_TTS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <div className="flex flex-col text-left">
                    <span className="text-xs font-medium">{o.label}</span>
                    <span className="text-muted-foreground text-[10px]">{o.desc}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-[11px]">
            OpenRouter speech models — see{" "}
            <a href="https://openrouter.ai/collections/text-to-speech-models" target="_blank" rel="noreferrer" className="underline">
              TTS collection
            </a>{" "}
            &{" "}
            <a href="https://openrouter.ai/announcements/announcing-audio-apis" target="_blank" rel="noreferrer" className="underline">
              audio API announcement
            </a>
            . Auto-falls back to local macOS voice if the cloud call fails.
          </p>

          {/* Voice style — pins ONE voice take per response (Fish natural-language steering) */}
          <div className="space-y-1.5 pt-1">
            <Label htmlFor="voice-style" className="flex items-center gap-1.5 text-xs font-semibold">
              <AudioLines className="size-3.5" /> Voice style (Fish)
            </Label>
            <Input
              id="voice-style"
              value={localVoiceStyle}
              onChange={(e) => setLocalVoiceStyle(e.target.value)}
              onBlur={() => {
                if (localVoiceStyle !== (voiceStyle ?? "")) {
                  void update.mutateAsync({ instanceId, voiceStyle: localVoiceStyle.trim() });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              placeholder='e.g. "deep warm male, unhurried British accent"'
              className="h-8 text-xs"
              maxLength={300}
              disabled={update.isPending}
            />
            <p className="text-muted-foreground text-[11px]">
              Free-text description that pins the SAME voice for every response — no more voice switching between
              sentences. Empty = Fish default voice.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
