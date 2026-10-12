"use client";
// The rep app (PRD §7.5). One client-side screen: Today (list or map) and Settings, all working from cached
// data and the outbox, so nothing here needs a network request after the first load. Every action is written
// to the outbox first; the sync runner sends it when it can.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Settings } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { BottomBar, SegmentedToggle } from "@/components/ui/BottomBar";
import { OfflineBanner } from "@/components/ui/OfflineBanner";
import { useToast } from "@/components/ui/Toast";
import { haversineMeters } from "@/lib/domain/geo";
import { getFix } from "@/lib/rep/geo";
import { formatDistance, navigateUrl, newClientId, type MapsApp } from "@/lib/rep/helpers";
import { cacheToday, useLocationSharing, useOnline, useOutboxItems, usePush, useSyncRunner, useVisible } from "@/lib/rep/hooks";
import { outbox, type Fix, type NewItem } from "@/lib/rep/outbox";
import { applyOutbox, onShift, sections, summarize } from "@/lib/rep/overlay";
import { prefetchRouteTiles } from "@/lib/rep/tiles";
import { isDusk } from "@/lib/ui/sunset";
import { THEME_COOKIE } from "@/lib/ui/theme";
import type { TodayResponse, TodayStop } from "@/lib/services/repApp";
import type { getMe } from "@/lib/services/users";
import { ConfirmSheet } from "./ConfirmSheet";
import { InstallCard } from "./InstallCard";
import { LogVisitSheet } from "./LogVisitSheet";
import { SettingsView } from "./SettingsView";
import { SkipSheet } from "./SkipSheet";
import { StopSheet } from "./StopSheet";
import { CurrentCard, DoneGroup, UpNext } from "./TodayList";

export type MeResponse = Awaited<ReturnType<typeof getMe>>;
export type Bootstrap = { today: TodayResponse | null; me: MeResponse | null; mapsApp: MapsApp | null; installDismissed: boolean };

const RepMap = dynamic(() => import("./RepMap"), { ssr: false, loading: () => <div className="h-[60dvh] min-h-80 animate-pulse rounded-md bg-surface-sunken" /> });

class SessionEnded extends Error {}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (res.status === 401) throw new SessionEnded();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function RepApp({ initial }: { initial: Bootstrap }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const online = useOnline();
  const visible = useVisible();
  const [view, setView] = useState<"list" | "map" | "settings">("list");
  const [mapsApp, setMapsApp] = useState<MapsApp>(initial.mapsApp ?? "google");
  const [installDismissed, setInstallDismissed] = useState(initial.installDismissed);

  // --- Data: the server's day (from cache first), the user's settings --------------------------------
  const todayQuery = useQuery({
    queryKey: ["today"],
    queryFn: async () => {
      const data = await fetchJson<TodayResponse>("/api/v1/rep/today");
      await cacheToday(data);
      return data;
    },
    initialData: initial.today ?? undefined,
    initialDataUpdatedAt: 0, // from the cache: show it now, and refetch at once
    refetchOnWindowFocus: true,
  });
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const data = await fetchJson<MeResponse>("/api/v1/me");
      await outbox().setCache("me", data);
      return data;
    },
    initialData: initial.me ?? undefined,
    initialDataUpdatedAt: 0,
    staleTime: 5 * 60_000,
  });
  const me = meQuery.data ?? null;

  // --- Queue and sync ---------------------------------------------------------------------------------
  const items = useOutboxItems();
  const pending = useMemo(() => summarize(items), [items]);
  const waiting = items.filter((i) => i.status === "pending").length;
  const sync = useSyncRunner(waiting);

  const today = useMemo(() => applyOutbox(todayQuery.data ?? null, items), [todayQuery.data, items]);
  const dayOn = onShift(today);
  const { current, upNext, done } = useMemo(() => sections(today), [today]);
  const tz = today?.timeZone ?? "America/Chicago";

  // --- Location (only while the day is on) ----------------------------------------------------------
  const location = useLocationSharing(dayOn, me?.client.foregroundPingSeconds ?? 120);
  const push = usePush(me?.client.vapidPublicKey ?? null);

  // Automatic theme (PRD REP-12): dusk after local sunset, from where the rep is working today.
  const sunPoint = location.last ?? (today && today.stops.length ? { lat: today.stops.reduce((n, x) => n + x.door.lat, 0) / today.stops.length, lng: today.stops.reduce((n, x) => n + x.door.lng, 0) / today.stops.length } : null);
  const sunLat = sunPoint?.lat ?? null;
  const sunLng = sunPoint?.lng ?? null;
  const prefTheme = me?.user.preferences.theme;
  useEffect(() => {
    if (sunLat === null || sunLng === null) return;
    const apply = () => {
      const cookie = document.cookie.split("; ").find((c) => c.startsWith(`${THEME_COOKIE}=`))?.split("=")[1];
      if ((cookie ?? prefTheme ?? "auto") !== "auto") return;
      document.documentElement.setAttribute("data-theme", isDusk(new Date(), sunLat, sunLng) ? "dusk" : "day");
    };
    apply();
    const id = setInterval(apply, 60_000);
    window.addEventListener("canvass-theme-change", apply);
    return () => {
      clearInterval(id);
      window.removeEventListener("canvass-theme-change", apply);
    };
  }, [sunLat, sunLng, prefTheme]);
  // Poll for new doors every minute while the app is open and push can't tell us (PRD REP-9).
  useEffect(() => {
    if (push.status === "on" || !visible) return;
    const id = setInterval(() => void queryClient.invalidateQueries({ queryKey: ["today"] }), 60_000);
    return () => clearInterval(id);
  }, [push.status, visible, queryClient]);

  // --- Warm the offline map: the map code, then the tiles around the route ---------------------------
  const routeKey = (today?.stops ?? []).map((s) => s.assignmentId).join(",");
  const warmed = useRef("");
  useEffect(() => {
    if (!online || !routeKey || warmed.current === routeKey) return;
    warmed.current = routeKey;
    void import("./RepMap");
    void prefetchRouteTiles((today?.stops ?? []).map((s) => ({ lat: s.door.lat, lng: s.door.lng })), process.env.NEXT_PUBLIC_MAP_STYLE_URL || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the set of stops
  }, [online, routeKey]);

  // --- "Just added" stops (a hot door pushed mid-route) ----------------------------------------------
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const ids = new Set((today?.stops ?? []).map((s) => s.assignmentId));
    if (seen.current && ids.size) {
      const added = [...ids].filter((id) => !seen.current!.has(id));
      if (added.length) {
        const t = setTimeout(() => setFresh((f) => new Set([...f, ...added])), 0);
        const clear = setTimeout(() => setFresh((f) => new Set([...f].filter((x) => !added.includes(x)))), 60_000);
        seen.current = ids;
        return () => {
          clearTimeout(t);
          clearTimeout(clear);
        };
      }
    }
    if (ids.size) seen.current = ids;
  }, [today?.stops]);

  // --- Actions -----------------------------------------------------------------------------------------
  const [openStop, setOpenStop] = useState<TodayStop | null>(null);
  const [visitStop, setVisitStop] = useState<TodayStop | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [offSite, setOffSite] = useState<{ stop: TodayStop; fix: Fix | null; meters: number | null } | null>(null);
  const [leaving, setLeaving] = useState<TodayStop | null>(null);
  const [replanning, setReplanning] = useState(false);
  const [skipping, setSkipping] = useState<TodayStop | null>(null);

  // Analytics only the phone knows (PRD §10): queued like everything else, best effort.
  const track = useCallback((name: "rep.visit_form_opened" | "rep.navigate_tapped", data?: Record<string, string | number | boolean | null>) => {
    void outbox().add([{ kind: "event", payload: { clientId: newClientId(), name, at: new Date().toISOString(), data } }]);
  }, []);

  function openVisit(stop: TodayStop) {
    track("rep.visit_form_opened", { outcomeRequired: true });
    setVisitStop(stop);
  }

  async function confirmSkip(reason: "CLOSED" | "UNSAFE" | "OUT_OF_TIME" | "OTHER", note: string) {
    const stop = skipping;
    setSkipping(null);
    if (!stop) return;
    await enqueue({ kind: "skip", payload: { clientId: newClientId(), assignmentId: stop.assignmentId, reason, ...(note ? { note } : {}), recordedAt: new Date().toISOString() } });
    toast.show("Stop skipped");
  }

  const enqueue = useCallback(
    async (item: NewItem, blobs?: { id: string; blob: Blob }[]) => {
      await outbox().add([item], blobs);
    },
    [],
  );

  async function startDay() {
    const { fix, denied } = await getFix(6000);
    location.setDenied(denied);
    if (fix) location.setLast(fix);
    await enqueue({ kind: "shift.start", payload: { clientId: newClientId(), location: fix, recordedAt: new Date().toISOString() } });
    toast.show("Day started");
  }

  async function endDay() {
    setConfirmEnd(false);
    const { fix } = await getFix(4000);
    await enqueue({ kind: "shift.end", payload: { clientId: newClientId(), location: fix, recordedAt: new Date().toISOString() } });
    toast.show("Day ended");
  }

  async function markArrived(stop: TodayStop) {
    setOpenStop(null);
    const { fix, denied } = await getFix(5000);
    location.setDenied(denied);
    if (fix) location.setLast(fix);
    const radius = me?.client.arrivalRadiusMeters ?? 200;
    const meters = fix ? haversineMeters(fix, stop.door) : null;
    // Beyond the radius (or with no fix) the rep confirms; the visit is flagged off-site but never blocked.
    if (meters === null || meters > radius) return setOffSite({ stop, fix, meters });
    await recordArrival(stop, fix);
  }

  async function recordArrival(stop: TodayStop, fix: Fix | null) {
    setOffSite(null);
    await enqueue({ kind: "arrive", payload: { clientId: newClientId(), assignmentId: stop.assignmentId, location: fix, recordedAt: new Date().toISOString() } });
    toast.show("Marked as arrived");
  }

  function navigate(stop: TodayStop) {
    track("rep.navigate_tapped", { app: mapsApp });
    window.open(navigateUrl(mapsApp, stop.door.lat, stop.door.lng), "_blank", "noopener");
  }

  async function saveVisit(stop: TodayStop, newItems: NewItem[], blobs: { id: string; blob: Blob }[]) {
    await outbox().add(newItems, blobs);
    setVisitStop(null);
    setOpenStop(null);
    toast.show("Visit saved");
    // The hanger swings on its hole, then leaves. With reduced motion the durations are 0 and it just goes.
    const ms = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dur-swing")) || 0;
    if (ms > 0) {
      setLeaving(stop);
      setTimeout(() => setLeaving(null), ms + 80);
    }
  }

  async function replan() {
    setReplanning(true);
    try {
      const { fix } = await getFix(5000);
      const res = await fetch("/api/v1/rep/replan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ location: fix }) });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as TodayResponse;
      queryClient.setQueryData(["today"], data);
      await cacheToday(data);
      toast.show("Route updated");
    } catch {
      toast.show("Couldn't update the route. Try again when you have signal.");
    } finally {
      setReplanning(false);
    }
  }

  async function changeMapsApp(app: MapsApp) {
    setMapsApp(app);
    await outbox().setCache("mapsApp", app);
    void fetch("/api/v1/me/preferences", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ mapsApp: app }) }).catch(() => undefined);
  }

  async function dismissInstall() {
    setInstallDismissed(true);
    await outbox().setCache("installDismissed", true);
  }

  // --- Banner (one at a time, most urgent first) ------------------------------------------------------
  const count = pending.visits > 0 ? plural(pending.visits, "visit", "visits") : plural(pending.changes, "change", "changes");
  let banner: React.ReactNode = null;
  if (sync.stopped === "auth") {
    banner = (
      <OfflineBanner tone="auth">
        Your session ended. <Link href="/login" className="font-bold underline">Sign in again</Link> to sync {count}.
      </OfflineBanner>
    );
  } else if (pending.failed > 0) {
    banner = (
      <OfflineBanner
        tone="failed"
        onClick={() => {
          void outbox().retryFailed().then(() => sync.syncNow());
        }}
      >
        {plural(pending.failed, "visit didn't sync", "visits didn't sync")}. Tap to retry.
        {pending.failedItems[0]?.lastError ? ` ${pending.failedItems[0].lastError}` : ""}
      </OfflineBanner>
    );
  } else if (!online || sync.stopped === "offline") {
    banner = <OfflineBanner tone="offline">{waiting > 0 ? `Offline. ${count} will sync when you're back online.` : "Offline. You can keep working. Everything you log will sync later."}</OfflineBanner>;
  } else if (sync.flushing && waiting > 0) {
    banner = <OfflineBanner tone="syncing">Syncing {count}</OfflineBanner>;
  } else if (sync.stopped === "server" && waiting > 0) {
    banner = <OfflineBanner tone="offline">Can&apos;t reach the server right now. {count} will sync when it&apos;s back.</OfflineBanner>;
  }

  if (view === "settings") {
    return (
      <SettingsView
        prefs={me?.user.preferences ?? {}}
        mapsApp={mapsApp}
        onMapsApp={(a) => void changeMapsApp(a)}
        push={push}
        pending={items.filter((i) => i.kind !== "ping" && i.kind !== "event").length}
        online={online}
        onBack={() => setView("list")}
      />
    );
  }

  // --- Today ---------------------------------------------------------------------------------------------
  const total = today?.stops.length ?? 0;
  const open = (today?.stops ?? []).filter((s) => s.status === "ACTIVE").length;
  const status = !today ? "Loading your day…" : total === 0 ? "No stops yet" : dayOn ? `${open} of ${total} stops left` : `${plural(total, "stop", "stops")} planned`;
  const allDone = dayOn && open === 0;
  const mapStops = (today?.stops ?? []).map((s) => ({ assignmentId: s.assignmentId, routeOrder: s.routeOrder, status: s.status, lat: s.door.lat, lng: s.door.lng, hot: s.door.priority === "HOT", name: s.door.companyName }));

  return (
    <div className="flex flex-col gap-4 pb-[calc(var(--bar-height)+env(safe-area-inset-bottom)+24px)] pt-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-title-l">Today</h1>
          <p className="tnum text-body-l text-ink-2">{status}</p>
          {dayOn && (
            <p className="mt-1 flex items-center gap-2 text-caption text-ink-2">
              <span aria-hidden="true" className="size-2.5 rounded-full bg-green-solid" />
              Sharing location while your day is on
            </p>
          )}
        </div>
        <button type="button" onClick={() => setView("settings")} aria-label="Settings" className="grid size-12 place-items-center rounded-sm text-ink-2">
          <Settings aria-hidden="true" size={24} strokeWidth={1.75} />
        </button>
      </header>

      {banner}
      {location.denied && dayOn && (
        <p role="alert" className="rounded-sm bg-amber-bg px-3 py-3 text-body text-amber-fg">
          Canvass needs your location to log visits. Turn it on in Settings, then come back.
        </p>
      )}
      {!installDismissed && <InstallCard onDismiss={() => void dismissInstall()} />}

      {today && total === 0 && (
        <p className="text-body-l text-ink-2">No stops today. New doors will show up here as they&apos;re assigned.</p>
      )}

      {view === "map" && today ? (
        <RepMap stops={mapStops} me={location.last} currentId={current?.assignmentId ?? null} onSelect={(id) => setOpenStop(today.stops.find((s) => s.assignmentId === id) ?? null)} />
      ) : (
        today && (
          <>
            {leaving && <CurrentCard stop={leaving} timeZone={tz} dayOn={dayOn} swinging ghost onNavigate={() => undefined} onArrived={() => undefined} onOpen={() => undefined} />}
            {current && (
              <CurrentCard
                key={current.assignmentId}
                stop={current}
                timeZone={tz}
                dayOn={dayOn}
                isNew={fresh.has(current.assignmentId)}
                rising={Boolean(leaving)}
                onNavigate={() => navigate(current)}
                onArrived={() => void markArrived(current)}
                onOpen={() => setOpenStop(current)}
              />
            )}
            {allDone && total > 0 && <p className="text-body-l">That&apos;s every stop. End your day when you&apos;re done.</p>}
            <UpNext stops={upNext} timeZone={tz} onOpen={setOpenStop} />
            <DoneGroup stops={done} timeZone={tz} onOpen={setOpenStop} />
          </>
        )
      )}

      {dayOn && open > 1 && online && (
        <Button variant="quiet" size="rep" onClick={() => void replan()} disabled={replanning} className="self-start">
          <RefreshCw aria-hidden="true" size={20} />
          Re-plan from here
        </Button>
      )}

      <BottomBar
        left={
          <SegmentedToggle
            label="View"
            value={view === "map" ? "map" : "list"}
            options={[
              { value: "list", label: "List" },
              { value: "map", label: "Map" },
            ]}
            onChange={(v) => setView(v)}
          />
        }
        right={
          !dayOn ? (
            <Button size="rep" block onClick={() => void startDay()} disabled={!today}>
              Start day
            </Button>
          ) : allDone ? (
            <Button size="rep" block onClick={() => void endDay()}>
              End day
            </Button>
          ) : (
            <Button size="rep" block disabled={!current} onClick={() => current && openVisit(current)}>
              Log visit
            </Button>
          )
        }
      />
      {dayOn && !allDone && (
        <button type="button" onClick={() => (open > 0 ? setConfirmEnd(true) : void endDay())} className="self-start text-label text-link underline underline-offset-4">
          End day
        </button>
      )}

      <StopSheet
        stop={openStop}
        timeZone={tz}
        dayOn={dayOn}
        onClose={() => setOpenStop(null)}
        onNavigate={navigate}
        online={online}
        onSkip={(s) => {
          setOpenStop(null);
          setSkipping(s);
        }}
        onArrived={(s) => void markArrived(s)}
        onLog={(s) => {
          setOpenStop(null);
          openVisit(s);
        }}
      />
      <SkipSheet companyName={skipping?.door.companyName ?? ""} open={skipping !== null} onCancel={() => setSkipping(null)} onConfirm={(r, n) => void confirmSkip(r, n)} />
      <LogVisitSheet stop={visitStop} timeZone={tz} onClose={() => setVisitStop(null)} onSave={saveVisit} />
      <ConfirmSheet open={confirmEnd} title="End your day?" confirmLabel="End day" onConfirm={() => void endDay()} onCancel={() => setConfirmEnd(false)}>
        {plural(open, "stop", "stops")} not visited. They&apos;ll move to your next working day.
      </ConfirmSheet>
      <ConfirmSheet
        open={offSite !== null}
        title="Mark as arrived?"
        confirmLabel="Mark arrived anyway"
        onConfirm={() => offSite && void recordArrival(offSite.stop, offSite.fix)}
        onCancel={() => setOffSite(null)}
      >
        {offSite?.meters != null
          ? `You're ${formatDistance(offSite.meters)} from this address. Log the visit anyway?`
          : "Canvass can't find your location. Log the visit anyway?"}
      </ConfirmSheet>
    </div>
  );
}
