"use client";

import { useCallback, useMemo, useState } from "react";
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
  const { data: openRouterModels, isLoading: isLoadingOpenRouter, refetch: refetchOpenRouterModels } =
    trpc.nimitsJarvis.getOpenRouterModels.useQuery();
  const { data: localModels, isLoading: isLoadingLocal, refetch: refetchLocalModels } =
    trpc.nimitsJarvis.getLocalModels.useQuery();

  const isLoading = isLoadingOpenRouter || isLoadingLocal || isInstanceLoading;

  // Manual rescan of live model sources (Ollama /api/tags + OpenRouter catalog).
  // Backs the "Refresh models" button in settings — refetch bypasses the
  // react-query cache so newly pulled local models appear immediately, and
  // every dropdown sharing this cache (settings + per-chat selector) updates.
  //
  // Result semantics: `ok` is false on transport failure, or when a rescan
  // wipes a previously non-empty local list (the server answers [] when
  // Ollama is unreachable, so that shape means the scan itself failed).
  // `updated` compares local model ids before/after.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refresh = useCallback(async (): Promise<{ ok: boolean; updated: boolean }> => {
    setIsRefreshing(true);
    try {
      const before = JSON.stringify((localModels ?? []).map((m) => m.id).sort());
      const [localRes, remoteRes] = await Promise.all([
        refetchLocalModels(),
        refetchOpenRouterModels(),
      ]);
      if (localRes.error || remoteRes.error) return { ok: false, updated: false };
      const afterIds = (localRes.data ?? []).map((m) => m.id).sort();
      if (afterIds.length === 0 && before !== "[]") return { ok: false, updated: false };
      return { ok: true, updated: JSON.stringify(afterIds) !== before };
    } catch {
      return { ok: false, updated: false };
    } finally {
      setIsRefreshing(false);
    }
  }, [localModels, refetchLocalModels, refetchOpenRouterModels]);

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

  return { allModels, grouped, groupedKeys, isLoading, refresh, isRefreshing };
}
