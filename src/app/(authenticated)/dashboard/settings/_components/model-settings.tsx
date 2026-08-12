"use client";

import { useState, useMemo } from "react";
import { Shield, Cpu, Loader2, ChevronsUpDown, Check } from "lucide-react";
import { trpc } from "~/clients/trpc";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import {
  showSuccessToast,
  trpcToastOnError,
} from "~/components/core/toast-notifications";
import { useModelCatalog } from "~/hooks/use-model-catalog";

export interface ModelSettingsProps {
  /** Resolved project (instance) this settings view is bound to. */
  instanceId: string;
  piiRedactionEnabled: boolean;
  openRouterGatewayEnabled: boolean;
  defaultModel: string;
}

export function ModelSettings({
  instanceId,
  piiRedactionEnabled,
  openRouterGatewayEnabled,
  defaultModel,
}: ModelSettingsProps) {
  const [piiEnabled, setPiiEnabled] = useState(piiRedactionEnabled);
  const [openRouterEnabled, setOpenRouterEnabled] = useState(
    openRouterGatewayEnabled,
  );
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const utils = trpc.useUtils();

  const updateSettings = trpc.nimitsJarvis.updateSettings.useMutation({
    onSuccess: () => {
      showSuccessToast("Settings updated");
      void utils.nimitsJarvis.getInstance.invalidate();
      void utils.chats.list.invalidate();
    },
    onError: trpcToastOnError,
  });

  const { allModels, grouped, groupedKeys, isLoading } = useModelCatalog(
    defaultModel,
    instanceId,
  );

  const filteredModels = useMemo(() => {
    if (!modelSearch.trim()) return allModels;
    const cleanSearch = modelSearch.toLowerCase();
    return allModels.filter(
      (m) =>
        m.label.toLowerCase().includes(cleanSearch) ||
        m.value.toLowerCase().includes(cleanSearch) ||
        m.provider.toLowerCase().includes(cleanSearch),
    );
  }, [allModels, modelSearch]);

  const filteredGrouped = useMemo(() => {
    const groups: Record<string, typeof allModels> = {};
    filteredModels.forEach((m) => {
      if (!groups[m.provider]) {
        groups[m.provider] = [];
      }
      groups[m.provider]!.push(m);
    });
    return groups;
  }, [filteredModels]);

  const filteredGroupedKeys = useMemo(() => {
    return Object.keys(filteredGrouped).sort((a, b) => {
      if (a === "local") return -1;
      if (b === "local") return 1;
      return a.localeCompare(b);
    });
  }, [filteredGrouped]);

  const selectedModel = allModels.find((m) => m.value === defaultModel);

  const handleSelectModel = (value: string) => {
    setModelOpen(false);
    if (value === defaultModel) return;
    void updateSettings.mutateAsync({ instanceId, anthropicModel: value });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Security Settings</CardTitle>
        <CardDescription>
          Manage data privacy and protection layers
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* PII Protection Toggle */}
        <div>
          <div className="flex items-center justify-between">
            <div className="flex items-start gap-3">
              <Shield className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
              <div className="space-y-0.5">
                <Label
                  htmlFor="pii-toggle"
                  className="cursor-pointer text-sm font-semibold"
                >
                  PII Protection
                </Label>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  When enabled, sensitive data (emails, phone numbers, names)
                  from your connected services is redacted before being sent to
                  external AI models and restored in the response. Local models
                  are always exempt.
                </p>
              </div>
            </div>
            <Switch
              id="pii-toggle"
              checked={piiEnabled}
              onCheckedChange={(checked) => {
                setPiiEnabled(checked);
                void updateSettings.mutateAsync({
                  instanceId,
                  piiRedactionEnabled: checked,
                });
              }}
              disabled={updateSettings.isPending}
            />
          </div>
        </div>

        {/* API Gateway Toggle */}
        <div className="mt-2 space-y-4 border-t pt-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label
                htmlFor="openrouter-gateway-toggle"
                className="cursor-pointer text-sm font-semibold"
              >
                OpenRouter Gateway
              </Label>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Enable models routed through OpenRouter (provides access to
                thousands of open-source and proprietary models).
              </p>
            </div>
            <Switch
              id="openrouter-gateway-toggle"
              checked={openRouterEnabled}
              onCheckedChange={(checked) => {
                setOpenRouterEnabled(checked);
                void updateSettings.mutateAsync({
                  instanceId,
                  openRouterGatewayEnabled: checked,
                });
              }}
              disabled={updateSettings.isPending}
            />
          </div>
        </div>

        {/* Default Model */}
        <div className="mt-2 border-t pt-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Cpu className="text-primary mt-0.5 h-5 w-5 shrink-0" />
              <Label htmlFor="default-model" className="text-sm font-semibold">
                Default Model
              </Label>
            </div>
            <p className="text-muted-foreground text-xs leading-relaxed">
              The model new chats use by default. You can still switch models
              per chat from the chat input.
            </p>
          </div>

          <Popover open={modelOpen} onOpenChange={setModelOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={modelOpen}
                className="mt-2 w-full justify-between font-normal"
                disabled={updateSettings.isPending}
              >
                <span className="truncate">
                  {updateSettings.isPending
                    ? "Saving..."
                    : selectedModel
                      ? selectedModel.label
                      : defaultModel}
                </span>
                <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-full p-2 sm:w-[350px]" align="start">
              <div className="space-y-2">
                <Input
                  placeholder="Search models..."
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  className="h-8 text-xs"
                />
                <div className="max-h-[300px] space-y-1 overflow-y-auto">
                  {isLoading && allModels.length <= 1 ? (
                    <div className="text-muted-foreground flex items-center justify-center py-6 text-center text-xs">
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                      Loading models catalog...
                    </div>
                  ) : filteredGroupedKeys.length === 0 ? (
                    <div className="text-muted-foreground py-6 text-center text-xs">
                      No models found.
                    </div>
                  ) : (
                    filteredGroupedKeys.map((provider) => (
                      <div key={provider} className="space-y-0.5">
                        <div className="text-muted-foreground border-border/20 mt-1 border-b px-2 py-1 text-[10px] font-semibold capitalize select-none">
                          {provider}
                        </div>
                        {filteredGrouped[provider]!.map((m) => (
                          <button
                            key={m.value}
                            onClick={() => handleSelectModel(m.value)}
                            className={cn(
                              "hover:bg-accent hover:text-accent-foreground flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                              defaultModel === m.value &&
                                "bg-accent text-accent-foreground font-medium",
                            )}
                          >
                            <div className="flex flex-col truncate pr-2">
                              <span className="font-medium">{m.label}</span>
                              <span className="text-muted-foreground/70 truncate text-[9px]">
                                {m.value}
                              </span>
                            </div>
                            {defaultModel === m.value && (
                              <Check className="h-3 w-3 shrink-0 opacity-100" />
                            )}
                          </button>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </CardContent>
    </Card>
  );
}
