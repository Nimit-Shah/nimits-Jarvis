"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { trpc } from "~/clients/trpc";
import {
  trpcToastOnError,
  showSuccessToast,
} from "~/components/core/toast-notifications";
import type { RouterOutputs } from "~/clients/trpc";

type ToolkitItem = RouterOutputs["toolkits"]["getToolkits"]["items"][number];

interface ToolkitCardProps {
  toolkit: ToolkitItem;
  instanceId?: string;
}

export function ToolkitCard({ toolkit, instanceId }: ToolkitCardProps) {
  const [logoLoaded, setLogoLoaded] = useState(false);
  const router = useRouter();

  const utils = trpc.useUtils();
  const getAuthLink = trpc.toolkits.getAuthLink.useMutation({
    onError: trpcToastOnError,
    onSuccess: () => void utils.toolkits.getToolkits.invalidate(),
  });

  const disconnectToolkit = trpc.toolkits.disconnectToolkit.useMutation({
    onSuccess: () => {
      showSuccessToast(`Disconnected ${toolkit.name}`);
      void utils.toolkits.getToolkits.invalidate();
    },
    onError: trpcToastOnError,
  });

  const handleConnect = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const { redirectUrl } = await getAuthLink.mutateAsync({
        instanceId,
        toolkit: toolkit.slug,
      });
      if (redirectUrl) {
        router.push(redirectUrl);
      } else {
        // No-auth toolkit (Composio code 4326): nothing to OAuth, already usable
        showSuccessToast(`${toolkit.name} is ready — no authentication needed`);
        void utils.toolkits.getToolkits.invalidate();
      }
    } catch {
      // trpcToastOnError handles toast
    }
  };

  const handleDisconnect = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!toolkit.connectionId) return;
    void disconnectToolkit.mutateAsync({
      instanceId,
      connectionId: toolkit.connectionId,
    });
  };

  return (
    <div className="group flex items-center gap-3 rounded-lg border border-border/40 bg-card/50 px-3 py-2.5 transition-all hover:border-border hover:bg-card">
      {/* Logo */}
      {/* eslint-disable-next-line @next/next/no-img-element -- external SVG from logos.composio.dev */}
      <img
        src={toolkit.logo}
        alt={`${toolkit.name} logo`}
        className="size-8 shrink-0 select-none rounded-md transition-opacity duration-200"
        style={{ opacity: logoLoaded ? 1 : 0 }}
        onLoad={() => setLogoLoaded(true)}
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
          className="h-6 shrink-0 px-2 text-[10px] text-muted-foreground hover:text-destructive hover:border-destructive/50"
          onClick={handleDisconnect}
          disabled={disconnectToolkit.isPending}
        >
          {disconnectToolkit.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            "Disconnect"
          )}
        </Button>
      ) : toolkit.noAuth ? (
        <span className="shrink-0 px-1 text-[10px] text-muted-foreground">
          No auth needed
        </span>
      ) : (
        <Button
          size="sm"
          className="h-6 shrink-0 px-2 text-[10px]"
          onClick={handleConnect}
          disabled={getAuthLink.isPending}
        >
          {getAuthLink.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            "Connect"
          )}
        </Button>
      )}
    </div>
  );
}