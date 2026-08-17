import { trpcServer, HydrateClient } from "~/clients/trpc/server";
import { SettingsPageClient } from "./_components/settings-page-client";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ instance?: string }>;
}) {
  const { instance } = await searchParams;

  if (instance) {
    await trpcServer.api.nimitsJarvis.getInstance.prefetch({
      instanceId: instance,
    });
  }

  return (
    <HydrateClient>
      <SettingsPageClient />
    </HydrateClient>
  );
}
