"use client";

import { useMemo } from "react";
import { trpc } from "~/clients/trpc";
import { useInstanceId } from "~/hooks/use-instance-id";

export interface CatalogModel {
  value: string;
  label: string;
  provider: string;
  description: string;
}

/**
 * Shared model catalog for every UI surface that lets the user pick a model
 * (per-chat selector, settings default-model dropdown).
 *
 * Composes the same three sources used by the old inline logic:
 *  1. Local Ollama models (with a qwen3:8b fallback when Ollama is down)
 *  2. OpenRouter models — only when the instance's OpenRouter gateway is on
 *  3. The currently-saved model (if it isn't already in the catalog), so the
 *     active selection always remains selectable and visible.
 *
 * Pass `explicitInstanceId` to pin the catalog to a specific project (e.g. the
 * settings page's RESOLVED instance). When omitted, the active URL/localStorage
 * instance is used.
 */
export function useModelCatalog(
  currentModel?: string,
  explicitInstanceId?: string,
) {
  const [urlInstanceId] = useInstanceId();
  const instanceId = explicitInstanceId ?? urlInstanceId;
  const { data: instance, isLoading: isInstanceLoading } =
    trpc.nimitsJarvis.getInstance.useQuery({ instanceId });
  const { data: openRouterModels, isLoading: isLoadingOpenRouter } =
    trpc.nimitsJarvis.getOpenRouterModels.useQuery();
  const { data: localModels, isLoading: isLoadingLocal } =
    trpc.nimitsJarvis.getLocalModels.useQuery();

  const isLoading = isLoadingOpenRouter || isLoadingLocal || isInstanceLoading;

  const allModels = useMemo(() => {
    const list: CatalogModel[] = [];

    if (localModels && localModels.length > 0) {
      localModels.forEach((lm) => {
        list.push({
          value: lm.id,
          label: lm.name,
          provider: "local",
          description: "Local model running on your machine",
        });
      });
    } else {
      list.push({
        value: "qwen3:8b",
        label: "Ollama Qwen3 8B (Local)",
        provider: "local",
        description: "Local model running on your machine",
      });
    }

    const openRouterGatewayEnabled =
      instance?.instance?.openRouterGatewayEnabled ?? true;

    if (
      openRouterGatewayEnabled &&
      openRouterModels &&
      openRouterModels.length > 0
    ) {
      openRouterModels.forEach((om) => {
        list.push({
          value: `openrouter/${om.id}`,
          label: om.name,
          provider: "openrouter",
          description: "OpenRouter model",
        });
      });
    }

    if (currentModel && !list.some((m) => m.value === currentModel)) {
      const parts = currentModel.split("/");
      const provider = parts.length > 1 ? parts[0]! : "custom";
      const label = parts.length > 1 ? parts.slice(1).join("/") : currentModel;
      list.push({
        value: currentModel,
        label: `${label} (Saved)`,
        provider,
        description: "Currently saved model configuration",
      });
    }

    return list;
  }, [openRouterModels, localModels, isLoading, currentModel, instance]);

  const grouped = useMemo(() => {
    const groups: Record<string, CatalogModel[]> = {};
    allModels.forEach((m) => {
      if (!groups[m.provider]) {
        groups[m.provider] = [];
      }
      groups[m.provider]!.push(m);
    });
    return groups;
  }, [allModels]);

  const groupedKeys = useMemo(() => {
    return Object.keys(grouped).sort((a, b) => {
      if (a === "local") return -1;
      if (b === "local") return 1;
      return a.localeCompare(b);
    });
  }, [grouped]);

  return { allModels, grouped, groupedKeys, isLoading };
}
