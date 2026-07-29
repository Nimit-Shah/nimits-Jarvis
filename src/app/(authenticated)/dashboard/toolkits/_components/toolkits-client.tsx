"use client";

import { useState, useEffect, useRef } from "react";
import { Search, Loader2 } from "lucide-react";
import { trpc } from "~/clients/trpc";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";
import { ErrorDisplay } from "~/components/core/error-display";
import { ErrorBoundary } from "~/components/core/error-boundary";
import { useInstanceId } from "~/hooks/use-instance-id";
import {
  trpcToastOnError,
  showSuccessToast,
} from "~/components/core/toast-notifications";

type FilterTab = "all" | "connected";

export function ToolkitsClient() {
  const [instanceId] = useInstanceId();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterTab>("all");

  const utils = trpc.useUtils();

  const isConnectedFilter = filter === "connected" ? true : undefined;

  const {
    data,
    isLoading,
    isFetching,
    error,
    refetch,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = trpc.toolkits.getToolkits.useInfiniteQuery(
    {
      instanceId,
      isConnected: isConnectedFilter,
      limit: 50,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      refetchInterval: 60_000,
    },
  );

  const getAuthLink = trpc.toolkits.getAuthLink.useMutation({
    onError: trpcToastOnError,
    onSuccess: () => void utils.toolkits.getToolkits.invalidate(),
  });

  const disconnectToolkit = trpc.toolkits.disconnectToolkit.useMutation({
    onSuccess: () => {
      showSuccessToast("Disconnected");
      void utils.toolkits.getToolkits.invalidate();
    },
    onError: trpcToastOnError,
  });

  const handleConnect = async (slug: string) => {
    try {
      const { redirectUrl } = await getAuthLink.mutateAsync({
        instanceId,
        toolkit: slug,
      });
      window.open(redirectUrl, "_blank");
    } catch {
      // toast handles it
    }
  };

  const handleDisconnect = (connectionId: string) => {
    void disconnectToolkit.mutateAsync({ instanceId, connectionId });
  };

  const allItems = data?.pages.flatMap((page) => page.items) ?? [];
  const connectedCount = allItems.filter((t) => t.connected).length;

  // Client-side search filter
  const filteredItems = allItems.filter((item) =>
    search.length === 0
      ? true
      : item.name.toLowerCase().includes(search.toLowerCase()) ||
        item.slug.toLowerCase().includes(search.toLowerCase()),
  );

  // Infinite scroll sentinel
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <ErrorDisplay
          message="Failed to load toolkits"
          retryText="Try again"
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border px-6 py-4 space-y-3">
        <div className="flex items-center gap-2">
          <h1 className="text-[15px] font-semibold text-foreground">Toolkits</h1>
          {connectedCount > 0 && (
            <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
              {connectedCount} connected
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search toolkits..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-[12px]"
            />
          </div>

          {/* Filter tabs */}
          <div className="flex items-center gap-1">
            <Button
              variant={filter === "all" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => setFilter("all")}
            >
              All
            </Button>
            <Button
              variant={filter === "connected" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => setFilter("connected")}
            >
              Connected
            </Button>
          </div>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <ErrorBoundary>
          {filteredItems.length === 0 && !isFetching ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <p className="text-[13px] text-muted-foreground">
                {search
                  ? "No toolkits match your search"
                  : filter === "connected"
                    ? "No connected toolkits yet"
                    : "No toolkits available"}
              </p>
            </div>
          ) : (
            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
              {filteredItems.map((toolkit) => (
                <ToolkitTile
                  key={toolkit.slug}
                  toolkit={toolkit}
                  onConnect={() => void handleConnect(toolkit.slug)}
                  onDisconnect={() => handleDisconnect(toolkit.connectionId!)}
                  isConnecting={getAuthLink.isPending}
                  isDisconnecting={disconnectToolkit.isPending}
                />
              ))}
            </div>
          )}
        </ErrorBoundary>

        {/* Infinite scroll sentinel */}
        <div ref={loadMoreRef} className="h-1" />

        {/* Loading indicator during fetch */}
        {isFetchingNextPage && (
          <div className="flex justify-center py-4">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Toolkit Tile ──────────────────────────────────────────────────────────────

interface ToolkitTileProps {
  toolkit: {
    slug: string;
    name: string;
    logo: string;
    connected: boolean;
    connectionId: string | null;
  };
  onConnect: () => void;
  onDisconnect: () => void;
  isConnecting: boolean;
  isDisconnecting: boolean;
}

function ToolkitTile({
  toolkit,
  onConnect,
  onDisconnect,
  isConnecting,
  isDisconnecting,
}: ToolkitTileProps) {
  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-all",
        toolkit.connected
          ? "border-primary/20 bg-primary/5"
          : "border-border/40 bg-card/50 hover:border-border hover:bg-card",
      )}
    >
      {/* Logo */}
      {/* eslint-disable-next-line @next/next/no-img-element -- external SVG from logos.composio.dev */}
      <img
        src={toolkit.logo}
        alt=""
        className="size-8 shrink-0 rounded-md"
        draggable={false}
      />

      {/* Name */}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[12px] font-medium text-foreground">
          {toolkit.name}
        </h3>
      </div>

      {/* Action button */}
      {toolkit.connected ? (
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 px-2 text-[10px]"
          onClick={onDisconnect}
          disabled={isDisconnecting}
        >
          Disconnect
        </Button>
      ) : (
        <Button
          size="sm"
          className="h-6 shrink-0 px-2 text-[10px]"
          onClick={onConnect}
          disabled={isConnecting}
        >
          Connect
        </Button>
      )}
    </div>
  );
}
