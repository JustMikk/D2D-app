"use client";
// React hooks for the rep app: the outbox, connectivity, the sync runner, location sharing, push and install.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TodayResponse } from "@/lib/services/repApp";
import { getFix } from "./geo";
import { newClientId } from "./helpers";
import { outbox, type Fix, type OutboxItem } from "./outbox";
import { applyOutbox } from "./overlay";
import { flush, type StopReason } from "./sync";

/** The outbox contents, kept live (also across tabs). */
export function useOutboxItems(): OutboxItem[] {
  const [items, setItems] = useState<OutboxItem[]>([]);
  useEffect(() => {
    const box = outbox();
    let alive = true;
    const load = () => void box.list().then((list) => alive && setItems(list));
    load();
    const off = box.subscribe(load);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return items;
}

function subscribeOnline(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

/** The browser's own idea of connectivity. (The sync runner also reports when a send actually fails.) */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

function subscribeVisible(cb: () => void) {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}

export function useVisible(): boolean {
  return useSyncExternalStore(subscribeVisible, () => document.visibilityState === "visible", () => true);
}

/** Keep today's data in IndexedDB so the app opens from cache, offline, in under a second. */
export async function cacheToday(today: TodayResponse | undefined | null): Promise<void> {
  if (today) await outbox().setCache("today", { data: today, at: Date.now() });
}

export type SyncState = { flushing: boolean; stopped: StopReason | null };

/**
 * Sends the outbox whenever it can: on open, on reconnect, when the app comes to the front, every 30 seconds
 * while visible, and right after the rep does something. One flush at a time (across tabs too, when the
 * browser has Web Locks); the server is idempotent, so an overlap could not duplicate anything anyway.
 */
export function useSyncRunner(pendingCount: number): SyncState & { syncNow: () => void } {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SyncState>({ flushing: false, stopped: null });
  const running = useRef(false);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setState((s) => ({ ...s, flushing: true }));
    try {
      const doFlush = () =>
        flush(outbox(), {
          // Patch the cached day with the acknowledged action before it leaves the queue, so the screen never flickers back.
          onAck: async (item) => {
            queryClient.setQueryData<TodayResponse>(["today"], (old) => (old ? (applyOutbox(old, [item]) ?? old) : old));
            await cacheToday(queryClient.getQueryData<TodayResponse>(["today"]));
          },
        });
      const queuedBefore = (await outbox().list()).filter((i) => i.status === "pending" && i.kind !== "ping" && i.kind !== "event");
      const lock = typeof navigator !== "undefined" ? navigator.locks : undefined;
      const result = lock ? await lock.request("canvass-flush", { ifAvailable: true }, async (l) => (l ? doFlush() : null)) : await doFlush();
      if (result) {
        setState({ flushing: false, stopped: result.stopped });
        if (result.sent > 0) void queryClient.invalidateQueries({ queryKey: ["today"] });
        // Work that waited more than a minute (a stretch with no signal): record how much and how old (PRD §10).
        const oldest = queuedBefore.length ? Math.min(...queuedBefore.map((i) => i.createdAt)) : null;
        if (result.sent > 0 && oldest !== null && Date.now() - oldest > 60_000) {
          await outbox().add([{ kind: "event", payload: { clientId: newClientId(), name: "rep.offline_queue_flushed", at: new Date().toISOString(), data: { count: queuedBefore.length, oldestAgeS: Math.round((Date.now() - oldest) / 1000) } } }]);
        }
      } else {
        setState((s) => ({ ...s, flushing: false }));
      }
    } catch {
      setState({ flushing: false, stopped: "offline" });
    } finally {
      running.current = false;
    }
  }, [queryClient]);

  const visible = useVisible();
  // On open, and when the connection returns. (Deferred a tick: the runner updates state as it starts.)
  useEffect(() => {
    const first = setTimeout(() => void run(), 0);
    const onOnline = () => void run();
    window.addEventListener("online", onOnline);
    return () => {
      clearTimeout(first);
      window.removeEventListener("online", onOnline);
    };
  }, [run]);
  // Something new was queued, or the app came back to the front.
  useEffect(() => {
    if (!visible || pendingCount === 0) return;
    const t = setTimeout(() => void run(), 0);
    return () => clearTimeout(t);
  }, [pendingCount, visible, run]);
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => void run(), 30_000);
    return () => clearInterval(id);
  }, [visible, run]);

  return { ...state, syncNow: () => void run() };
}

/**
 * While the day is on and the app is open, record a fix every `intervalSec` seconds (PRD REP-8). Nothing is
 * collected when the day is off. Returns the latest fix and whether the phone denied location.
 */
export function useLocationSharing(on: boolean, intervalSec: number) {
  const [last, setLast] = useState<Fix | null>(null);
  const [denied, setDenied] = useState(false);
  const visible = useVisible();

  useEffect(() => {
    if (!on || !visible) return;
    let cancelled = false;
    const tick = async () => {
      const { fix, denied: d } = await getFix(8000, 60_000);
      if (cancelled) return;
      setDenied(d);
      if (!fix) return;
      setLast(fix);
      await outbox().add([{ kind: "ping", payload: { clientId: newClientId(), source: "FOREGROUND", ...fix } }]);
    };
    const id = setInterval(() => void tick(), Math.max(30, intervalSec) * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [on, visible, intervalSec]);

  return { last, setLast, denied, setDenied };
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=").replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushStatus = "unsupported" | "denied" | "off" | "on";

/** Push needs the installed PWA on iOS 16.4+, and a VAPID key from the server. Without it the app polls. */
export function usePush(vapidPublicKey: string | null) {
  const [status, setStatus] = useState<PushStatus>("unsupported");

  const refresh = useCallback(async () => {
    const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && Boolean(vapidPublicKey);
    if (!supported) return setStatus("unsupported");
    if (Notification.permission === "denied") return setStatus("denied");
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    setStatus(sub && Notification.permission === "granted" ? "on" : "off");
  }, [vapidPublicKey]);

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh]);

  const enable = useCallback(async () => {
    if (!vapidPublicKey) return false;
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      await refresh();
      return false;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) }));
    const json = sub.toJSON();
    const res = await fetch("/api/v1/push/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, userAgent: navigator.userAgent.slice(0, 300) }),
    });
    await refresh();
    return res.ok;
  }, [vapidPublicKey, refresh]);

  const disable = useCallback(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await fetch("/api/v1/push/subscriptions", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
      await sub.unsubscribe();
    }
    await refresh();
  }, [refresh]);

  return { status, enable, disable };
}

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

/** Android's install prompt, held until the rep taps Install. iOS has no prompt; the guide shows the steps. */
function subscribeStandalone(cb: () => void) {
  const mq = window.matchMedia("(display-mode: standalone)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
const noopSubscribe = () => () => undefined;

export function useInstall() {
  const [event, setEvent] = useState<InstallEvent | null>(null);
  const standalone = useSyncExternalStore(
    subscribeStandalone,
    () => window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    () => false,
  );
  const ios = useSyncExternalStore(noopSubscribe, () => /iPad|iPhone|iPod/.test(navigator.userAgent), () => false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const install = async () => {
    if (!event) return;
    await event.prompt();
    await event.userChoice;
    setEvent(null);
  };
  return { standalone, ios, canPrompt: Boolean(event), install };
}

/** Register the service worker, then ask it to keep the files this page loaded (so the very first visit also works offline). */
export function useServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let cancelled = false;
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        if (cancelled) return;
        const urls = [...performance.getEntriesByType("resource").map((e) => e.name), location.origin + "/today"].filter((u) => u.includes("/_next/static/") || u.includes("/icons/") || u.endsWith("/today"));
        reg.active?.postMessage({ type: "WARM", urls });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
}
