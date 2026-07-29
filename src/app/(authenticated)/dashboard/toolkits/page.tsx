import { trpcServer, HydrateClient } from "~/clients/trpc/server";
import { ToolkitsClient } from "./_components/toolkits-client";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ instance?: string }>;
}) {
  const { instance } = await searchParams;

  if (instance) {
    void trpcServer.api.toolkits.getToolkits.prefetchInfinite({
      instanceId: instance,
      limit: 50,
    });
  }

  return (
    <HydrateClient>
      <ToolkitsClient />
    </HydrateClient>
  );
}
