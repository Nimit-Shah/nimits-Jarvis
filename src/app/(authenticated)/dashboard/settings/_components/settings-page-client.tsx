"use client";

import { useState } from "react";
import {
  Shield,
  MessageSquare,
  Clock,
  Brain,
  AlertTriangle,
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
import { useInstanceId } from "~/hooks/use-instance-id";

type SettingsCategory = "security" | "telegram" | "cron" | "memory" | "danger";

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
  const { data, isLoading, error } = trpc.nimitsJarvis.getInstance.useQuery({
    instanceId,
  });
  const instance = data?.instance ?? null;

  if (isLoading) {
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
