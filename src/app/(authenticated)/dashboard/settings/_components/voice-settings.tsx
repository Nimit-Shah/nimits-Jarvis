"use client";

import { useState } from "react";
import { Mic, Volume2, AudioLines } from "lucide-react";
import { trpc } from "~/clients/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";

const LOCAL_STT = [
  { value: "tiny", label: "Whisper Tiny", desc: "Fastest" },
  { value: "base", label: "Whisper Base", desc: "Fast" },
  { value: "small", label: "Whisper Small (Default)", desc: "Balanced" },
  { value: "medium", label: "Whisper Medium", desc: "Better with names" },
  { value: "large-v3", label: "Whisper Large v3", desc: "Most accurate" },
  { value: "large-v3-v20240930_626MB", label: "Whisper Large v3 (Legacy)", desc: "Older build" },
] as const;

const OPENROUTER_STT = [
  { value: "openai/whisper-1", label: "Whisper-1", desc: "Pay per minute" },
  { value: "openai/whisper-large-v3", label: "Whisper Large v3", desc: "High quality" },
  { value: "openai/gpt-4o-mini-transcribe", label: "GPT-4o Mini Transcribe", desc: "High volume" },
  { value: "openai/gpt-4o-transcribe", label: "GPT-4o Transcribe", desc: "Best quality" },
  { value: "mistralai/voxtral-mini-transcribe", label: "Voxtral Mini", desc: "Cheapest" },
  { value: "qwen/qwen3-asr-0.6b", label: "Qwen3 ASR", desc: "30 languages" },
] as const;

const STT_OPTIONS = [...LOCAL_STT, ...OPENROUTER_STT] as const;

// TTS via OpenRouter /api/v1/audio/speech — "fish-audio" and "openrouter" are
// aliases of the same path; voice format "<model>::<voice>" when a voice is needed.
const OPENROUTER_TTS = [
  { value: "fish-audio:s2.1-pro-free", label: "Fish S2.1 Pro (Default)", desc: "Free", provider: "fish-audio", voice: "s2.1-pro-free" },
  { value: "openrouter:fish-audio/s2.1-pro", label: "Fish S2.1 Pro", desc: "Production", provider: "openrouter", voice: "fish-audio/s2.1-pro" },
  { value: "openrouter:deepgram/flux-tts:free", label: "Deepgram Flux", desc: "Free backup", provider: "openrouter", voice: "deepgram/flux-tts:free" },
  { value: "openrouter:google/gemini-3.1-flash-tts-preview", label: "Gemini 3.1 Flash", desc: "70+ languages", provider: "openrouter", voice: "google/gemini-3.1-flash-tts-preview" },
] as const;

const LOCAL_TTS = [
  { value: "local-mac:Daniel (Enhanced)", label: "macOS Daniel", desc: "Offline", provider: "local-mac", voice: "Daniel (Enhanced)" },
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
          <Mic className="size-4" /> Voice Settings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* STT */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-sm font-semibold">
            <Mic className="size-3.5" /> Speech-to-Text Model
          </Label>
          <p className="text-muted-foreground text-xs">Runs on this device by default; cloud options bill through OpenRouter.</p>
          <Select value={localStt} onValueChange={handleSttChange} disabled={update.isPending}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={localStt} />
            </SelectTrigger>
            <SelectContent>
              <div className="px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">On this device</div>
              {LOCAL_STT.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <div className="flex flex-col text-left">
                    <span className="text-xs font-medium">{o.label}</span>
                    <span className="text-muted-foreground text-[10px]">{o.desc}</span>
                  </div>
                </SelectItem>
              ))}
              <div className="mt-1 border-t px-2 pt-1.5 text-[10px] font-semibold uppercase text-muted-foreground">Cloud</div>
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
          {update.isPending && <p className="text-muted-foreground text-[11px]">Saving...</p>}
        </div>

        {/* TTS */}
        <div className="space-y-2 border-t pt-4">
          <Label className="flex items-center gap-2 text-sm font-semibold">
            <Volume2 className="size-3.5" /> Text-to-Speech Voice
          </Label>
          <p className="text-muted-foreground text-xs">Speaks replies via the cloud by default, with an on-device fallback when offline.</p>
          <Select value={localTtsKey} onValueChange={handleTtsChange} disabled={update.isPending}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <div className="px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">Cloud</div>
              {OPENROUTER_TTS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <div className="flex flex-col text-left">
                    <span className="text-xs font-medium">{o.label}</span>
                    <span className="text-muted-foreground text-[10px]">{o.desc}</span>
                  </div>
                </SelectItem>
              ))}
              <div className="mt-1 border-t px-2 pt-1.5 text-[10px] font-semibold uppercase text-muted-foreground">On device</div>
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

          {/* Voice tone — pins ONE voice take per response (Fish natural-language steering) */}
          <div className="space-y-1.5 pt-1">
            <Label htmlFor="voice-style" className="flex items-center gap-1.5 text-xs font-semibold">
              <AudioLines className="size-3.5" /> Voice Tone
            </Label>
            <Textarea
              id="voice-style"
              value={localVoiceStyle}
              onChange={(e) => setLocalVoiceStyle(e.target.value)}
              onBlur={() => {
                if (localVoiceStyle !== (voiceStyle ?? "")) {
                  void update.mutateAsync({ instanceId, voiceStyle: localVoiceStyle.trim() });
                }
              }}
              placeholder='e.g. "deep warm male, unhurried British accent"'
              className="min-h-16 text-xs"
              rows={2}
              maxLength={300}
              disabled={update.isPending}
            />
            <p className="text-muted-foreground text-[11px]">
              Keeps one consistent voice across replies; empty uses the default.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
