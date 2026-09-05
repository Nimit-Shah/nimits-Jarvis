"use client";

import { useEffect, useState } from "react";
import {
  Shield,
  MessageSquare,
  Clock,
  Brain,
  AlertTriangle,
  Server,
  Mic,
  FolderOpen,
  Palette,
} from "lucide-react";
import { trpc } from "~/clients/trpc";
import Link from "next/link";
import { ErrorDisplay } from "~/components/core/error-display";
import { ErrorBoundary } from "~/components/core/error-boundary";
import { cn } from "~/lib/utils";
import { ModelSettings } from "./model-settings";
import { TelegramSettings } from "./telegram-settings";
import { CronJobsSettings } from "./cron-jobs-settings";
import { MemorySettings } from "./memory-settings";
import { DangerZone } from "./danger-zone";
import { VoiceSettings } from "./voice-settings";
import { FsSettings } from "./fs-settings";
import { ThemeSettings } from "./theme-settings";
import { useInstanceId } from "~/hooks/use-instance-id";
import { McpServersPanel } from "./mcp/mcp-servers-panel";

type SettingsCategory = "security" | "appearance" | "voice" | "files" | "telegram" | "cron" | "memory" | "mcp" | "danger";

const CATEGORIES: Array<{
  id: SettingsCategory;
  label: string;
  icon: typeof Shield;
  description: string;
}> = [
  {
    id: "security",
    label: "Security",
    icon: Shield,
    description: "PII protection and gateways",
  },
  {
    id: "appearance",
    label: "Themes",
    icon: Palette,
    description: "Solar Dusk & Zen Linen — with Save & reload",
  },
  {
    id: "voice",
    label: "Voice",
    icon: Mic,
    description: "STT & TTS — Fish Audio S1 Pro default",
  },
  {
    id: "files",
    label: "Files",
    icon: FolderOpen,
    description: "Local file access ceiling",
  },
  {
    id: "telegram",
    label: "Telegram",
    icon: MessageSquare,
    description: "Bot connection",
  },
  {
    id: "cron",
    label: "Scheduled Tasks",
    icon: Clock,
    description: "Recurring jobs",
  },
  {
    id: "memory",
    label: "Memory",
    icon: Brain,
    description: "AI memory and profile",
  },
  {
    id: "mcp",
    label: "MCP Servers",
    icon: Server,
    description: "External MCP endpoints (per project)",
  },
  {
    id: "danger",
    label: "Danger Zone",
    icon: AlertTriangle,
    description: "Delete project",
  },
];

export function SettingsPageClient() {
  const [instanceId] = useInstanceId();
  const [activeCategory, setActiveCategory] =
    useState<SettingsCategory>("security");
  // Gate content on mount: the server always renders the loading skeleton
  // (no ?instance= param, no query cache), but on client-side navigation the
  // cache may already be warm — rendering content on the first client pass
  // would mismatch the server HTML and force React to rebuild the tree.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Intentional mount gate (not derived state): first client render must
    // match the server skeleton — see comment below.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);
  const { data, isLoading, error } = trpc.nimitsJarvis.getInstance.useQuery({
    instanceId,
  });
  const instance = data?.instance ?? null;

  if (!mounted || isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="bg-muted h-5 w-5 animate-pulse rounded-md" />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorDisplay
        message={error.message}
        retryText="Try again"
        onRetry={() => window.location.reload()}
      />
    );
  }

  if (!instance) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="text-center">
          <p className="text-muted-foreground text-[13px]">
            No Nimits-Jarvis instance found.
          </p>
          <Link
            href="/dashboard"
            className="text-primary mt-2 inline-block text-[13px] hover:underline"
          >
            Go to Nimits-Jarvis
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Left: Category nav */}
      <div className="border-border w-[220px] shrink-0 space-y-0.5 border-r p-3">
        <h1 className="text-foreground px-2 pb-3 text-[13px] font-semibold">
          Settings
        </h1>
        {CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          const isActive = activeCategory === cat.id;
          return (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
                isActive
                  ? "bg-accent/60 text-foreground font-medium"
                  : "hover:bg-accent/30 text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              <span>{cat.label}</span>
            </button>
          );
        })}
      </div>

      {/* Right: Category content */}
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="pb-2">
            <h2 className="text-foreground text-[14px] font-semibold">
              {CATEGORIES.find((c) => c.id === activeCategory)?.label}
            </h2>
            <p className="text-muted-foreground text-[12px]">
              {CATEGORIES.find((c) => c.id === activeCategory)?.description}
            </p>
          </div>

          {activeCategory === "security" && (
            <ErrorBoundary>
              <ModelSettings
                instanceId={instance.id}
                piiRedactionEnabled={instance.piiRedactionEnabled}
                openRouterGatewayEnabled={instance.openRouterGatewayEnabled}
                defaultModel={instance.anthropicModel}
              />
            </ErrorBoundary>
          )}

          {activeCategory === "appearance" && (
            <ErrorBoundary>
              <ThemeSettings />
            </ErrorBoundary>
          )}

          {activeCategory === "voice" && (
            <ErrorBoundary>
              <VoiceSettings
                instanceId={instance.id}
                sttModel={(instance as any).sttModel ?? "small"}
                ttsProvider={(instance as any).ttsProvider ?? "fish-audio"}
                ttsVoice={(instance as any).ttsVoice ?? "s2.1-pro-free"}
                voiceStyle={(instance as any).voiceStyle ?? ""}
              />
            </ErrorBoundary>
          )}

          {activeCategory === "telegram" && data?.telegramConfigured && (
            <ErrorBoundary>
              <TelegramSettings />
            </ErrorBoundary>
          )}

          {activeCategory === "telegram" && !data?.telegramConfigured && (
            <p className="text-muted-foreground text-[12px]">
              Telegram is not configured on this deployment.
            </p>
          )}

          {activeCategory === "cron" && (
            <ErrorBoundary>
              <CronJobsSettings />
            </ErrorBoundary>
          )}

          {activeCategory === "memory" && (
            <ErrorBoundary>
              <MemorySettings />
            </ErrorBoundary>
          )}

          {activeCategory === "mcp" && (
            <ErrorBoundary>
              <McpServersPanel instanceId={instance.id} />
            </ErrorBoundary>
          )}

          {activeCategory === "files" && (
            <ErrorBoundary>
              <FsSettings
                instanceId={instance.id}
                fsReadEnabled={(instance as any).fsReadEnabled ?? true}
                fsWriteAllowed={(instance as any).fsWriteAllowed ?? false}
                fsRootPath={(instance as any).fsRootPath ?? null}
              />
            </ErrorBoundary>
          )}

          {activeCategory === "danger" && (
            <ErrorBoundary>
              <DangerZone />
            </ErrorBoundary>
          )}
        </div>
      </div>
    </div>
  );
}
