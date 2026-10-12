"use client";
// Starts the rep app: registers the service worker, reads the last cached day from IndexedDB (a few
// milliseconds, which is what lets Today render before any network request), then hands over to RepApp.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useServiceWorker } from "@/lib/rep/hooks";
import type { MapsApp } from "@/lib/rep/helpers";
import { outbox } from "@/lib/rep/outbox";
import type { TodayResponse } from "@/lib/services/repApp";
import { RepApp, type Bootstrap, type MeResponse } from "./RepApp";

export function RepRoot({ userId }: { userId: string }) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnReconnect: true } } }));
  useServiceWorker();

  useEffect(() => {
    let alive = true;
    void (async () => {
      const box = outbox();
      // The cache belongs to one person. If someone else signs in on this phone, start clean.
      const owner = await box.getCache<string>("owner");
      if (owner && owner !== userId) {
        await box.discardKinds(["ping", "event"]);
        await box.clearCache();
      }
      await box.setCache("owner", userId);
      const [today, me, mapsApp, installDismissed] = await Promise.all([
        box.getCache<{ data: TodayResponse }>("today"),
        box.getCache<MeResponse>("me"),
        box.getCache<MapsApp>("mapsApp"),
        box.getCache<boolean>("installDismissed"),
      ]);
      if (alive) setBoot({ today: owner && owner !== userId ? null : (today?.data ?? null), me: owner && owner !== userId ? null : (me ?? null), mapsApp: mapsApp ?? null, installDismissed: installDismissed ?? false });
    })();
    return () => {
      alive = false;
    };
  }, [userId]);

  if (!boot) {
    return (
      <div aria-busy="true" className="flex flex-col gap-4 pt-6">
        <div className="h-8 w-32 animate-pulse rounded-sm bg-surface-sunken" />
        <div className="h-64 animate-pulse rounded-md bg-surface-sunken" />
      </div>
    );
  }
  return (
    <QueryClientProvider client={client}>
      <RepApp initial={boot} />
    </QueryClientProvider>
  );
}
