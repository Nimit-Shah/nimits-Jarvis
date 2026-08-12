"use client";

import { useState, useMemo } from "react";
import { Loader2, ChevronsUpDown, Check } from "lucide-react";
import { trpc } from "~/clients/trpc";
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
import { useInstanceId } from "~/hooks/use-instance-id";
import { useModelCatalog } from "~/hooks/use-model-catalog";

interface ModelSelectorProps {
  chatId: string;
}

export function ModelSelector({ chatId }: ModelSelectorProps) {
  const [instanceId] = useInstanceId();
  const { data: instance, isLoading: isInstanceLoading } =
    trpc.nimitsJarvis.getInstance.useQuery({ instanceId });
  const { data: chats } = trpc.chats.list.useQuery({ instanceId });

  const currentChat = chats?.find((c) => c.id === chatId);
  const currentModel =
    currentChat?.model ?? instance?.instance?.anthropicModel ?? "qwen3:8b";

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const utils = trpc.useUtils();

  const updateModel = trpc.chats.updateModel.useMutation({
    onSuccess: () => {
      showSuccessToast("Model updated");
      void utils.chats.list.invalidate();
    },
    onError: trpcToastOnError,
  });

  const { allModels, isLoading } = useModelCatalog(currentModel);

  const filteredModels = useMemo(() => {
    if (!search.trim()) return allModels;
    const cleanSearch = search.toLowerCase();
    return allModels.filter(
      (m) =>
        m.label.toLowerCase().includes(cleanSearch) ||
        m.value.toLowerCase().includes(cleanSearch) ||
        m.provider.toLowerCase().includes(cleanSearch),
    );
  }, [allModels, search]);

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

  const selectedItem = allModels.find((m) => m.value === currentModel);

  const handleSelect = (modelValue: string) => {
    setOpen(false);
    if (modelValue === currentModel) return;
    void updateModel.mutateAsync({ chatId, model: modelValue });
  };

  if (isInstanceLoading) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground w-48 justify-between"
        disabled
      >
        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
        Loading...
      </Button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "text-muted-foreground hover:text-foreground max-w-[250px] justify-between text-xs font-normal",
            updateModel.isPending && "cursor-not-allowed opacity-50",
          )}
          disabled={updateModel.isPending}
        >
          <span className="truncate">
            {updateModel.isPending
              ? "Saving..."
              : selectedItem
                ? selectedItem.label
                : "Select model..."}
          </span>
          <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full p-2 sm:w-[350px]" align="start">
        <div className="space-y-2">
          <Input
            placeholder="Search models..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
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
                      onClick={() => handleSelect(m.value)}
                      className={cn(
                        "hover:bg-accent hover:text-accent-foreground group flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                        currentModel === m.value &&
                          "bg-accent text-accent-foreground font-medium",
                      )}
                    >
                      <div className="flex flex-col truncate pr-2">
                        <span className="font-medium">{m.label}</span>
                        <span className="text-muted-foreground/70 truncate text-[9px]">
                          {m.value}
                        </span>
                      </div>
                      {currentModel === m.value && (
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
  );
}
