"use client";
// Live map (PRD MGR-1): rep markers with a freshness ring, door pins by status, and the route line for a
// selected rep. Refreshes every 30 seconds. The side panel lists the same reps and doors so the map is
// never the only way to reach information (design doc §10).
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chip } from "@/components/ui/Chip";
import { Field, Input, Select } from "@/components/ui/Field";
import { DOOR_STATUSES, type DoorStatus } from "@/lib/domain/enums";
import { DEFAULT_STYLE_URL } from "@/lib/rep/tiles";
import type { DoorPin, Freshness, RepMarker } from "@/lib/services/mapLive";
import { applyTokenColors } from "@/lib/ui/mapStyle";
import { DOOR_STATUS, TONE_CLASSES } from "@/lib/ui/status";

type Live = { reps: RepMarker[]; doors: DoorPin[]; reviewCount: number; generatedAt: string };

const RING: Record<Freshness, string> = {
  FRESH: "outline outline-[3px] outline-offset-2 outline-green-solid",
  AGING: "outline-dashed outline-[3px] outline-offset-2 outline-amber-solid",
  STALE: "",
  NONE: "",
};

function ago(iso: string | null, now: number): string {
  if (!iso) return "No location yet";
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return m < 1 ? "Last seen just now" : m < 60 ? `Last seen ${m} min ago` : `Last seen ${Math.round(m / 60)} h ago`;
}

function repElement(r: RepMarker, selected: boolean, now: number): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.title = `${r.name}. ${ago(r.lastLocationAt, now)}`;
  el.setAttribute("aria-label", `${r.name}, ${r.onShift ? "on shift" : "off shift"}. ${ago(r.lastLocationAt, now)}`);
  el.className = `grid size-8 place-items-center rounded-full bg-surface-inverse text-caption font-bold text-ink-inverse ${RING[r.freshness]} ${selected ? "scale-125" : ""} ${r.onShift ? "" : "opacity-70"}`;
  el.textContent = r.initials;
  return el;
}

function pinElement(d: DoorPin, selected: boolean): HTMLElement {
  const meta = DOOR_STATUS[d.status];
  const el = document.createElement("button");
  el.type = "button";
  el.title = `${d.name}: ${meta.label}`;
  el.setAttribute("aria-label", `${d.name}, ${meta.label}${d.priority === "HOT" ? ", hot" : ""}`);
  // 2px ink outline on every pin; the fill alone (yellow on white is 1.8:1) could not define the edge.
  el.className = `tnum grid ${selected ? "size-9" : "size-7"} place-items-center rounded-full border-2 border-outline ${TONE_CLASSES[meta.tone].solid} text-caption font-bold text-on-action ${d.priority === "HOT" ? "shadow-[0_0_0_4px_var(--hot)]" : ""}`;
  el.textContent = d.routeOrder === null ? "" : String(d.routeOrder);
  return el;
}

export function LiveMap({ initial, defaultDate }: { initial: Live; defaultDate: string }) {
  const [data, setData] = useState<Live>(initial);
  const [date, setDate] = useState("");
  const [repId, setRepId] = useState("");
  const [status, setStatus] = useState<DoorStatus | "">("");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [clock, setClock] = useState(() => Date.parse(initial.generatedAt));
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const fitted = useRef(false);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (date) p.set("date", date);
    if (repId) p.set("repId", repId);
    if (status) p.set("status", status);
    return p.toString();
  }, [date, repId, status]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/map/live${query ? `?${query}` : ""}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error();
      const next = (await res.json()) as Live;
      setData(next);
      setClock(Date.parse(next.generatedAt));
      setError(null);
      fitted.current = false;
    } catch {
      setError("Couldn't refresh the map. Showing the last data.");
    }
  }, [query]);

  // Refresh on a filter change, then every 30 seconds.
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const id = setInterval(() => void load(), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load]);

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const maplibre = await import("maplibre-gl");
        if (cancelled || !container.current) return;
        const map = new maplibre.Map({ container: container.current, style: process.env.NEXT_PUBLIC_MAP_STYLE_URL || DEFAULT_STYLE_URL, center: [-96.8, 32.78], zoom: 9, attributionControl: { compact: true } });
        mapRef.current = map;
        map.on("load", () => {
          applyTokenColors(map);
          const css = getComputedStyle(document.documentElement);
          map.addSource("route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } } });
          map.addLayer({ id: "route-casing", type: "line", source: "route", paint: { "line-color": css.getPropertyValue("--surface").trim(), "line-width": 9 }, layout: { "line-cap": "round", "line-join": "round" } });
          map.addLayer({ id: "route-line", type: "line", source: "route", paint: { "line-color": css.getPropertyValue("--route").trim(), "line-width": 5 }, layout: { "line-cap": "round", "line-join": "round" } });
          setReady(true);
        });
        map.on("error", () => {
          if (!map.isStyleLoaded()) setMapError("The map tiles couldn't load. The lists beside it still work.");
        });
      } catch {
        if (!cancelled) setMapError("This browser can't show the map. The lists beside it still work.");
      }
    })();
    return () => {
      cancelled = true;
      markers.current.forEach((m) => m.remove());
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Draw markers, pins and the selected rep's route whenever the data or selection changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    void (async () => {
      const maplibre = await import("maplibre-gl");
      markers.current.forEach((m) => m.remove());
      markers.current = [];
      for (const d of data.doors) markers.current.push(new maplibre.Marker({ element: pinElement(d, d.repId === selected && selected !== null) }).setLngLat([d.lng, d.lat]).addTo(map));
      for (const r of data.reps) {
        if (r.lat === null || r.lng === null) continue;
        const el = repElement(r, r.repId === selected, clock);
        el.addEventListener("click", () => setSelected((s) => (s === r.repId ? null : r.repId)));
        markers.current.push(new maplibre.Marker({ element: el }).setLngLat([r.lng, r.lat]).addTo(map));
      }
      const rep = data.reps.find((r) => r.repId === selected);
      const stops = data.doors.filter((d) => d.repId === selected && d.routeOrder !== null).sort((a, b) => a.routeOrder! - b.routeOrder!);
      const line = [...(rep?.lat != null && rep.lng != null ? [[rep.lng, rep.lat]] : []), ...stops.map((d) => [d.lng, d.lat])];
      (map.getSource("route") as { setData: (d: unknown) => void } | undefined)?.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } });
      if (!fitted.current) {
        const points = [...data.doors.map((d) => [d.lng, d.lat]), ...data.reps.filter((r) => r.lat !== null).map((r) => [r.lng!, r.lat!])] as [number, number][];
        if (points.length) {
          const b = new maplibre.LngLatBounds(points[0], points[0]);
          points.forEach((p) => b.extend(p));
          map.fitBounds(b, { padding: 60, duration: 0, maxZoom: 13 });
          fitted.current = true;
        }
      }
    })();
  }, [data, selected, ready, clock]);

  const selectedRep = data.reps.find((r) => r.repId === selected) ?? null;

  return (
    <div className="grid grid-cols-12 gap-6">
      <div className="col-span-7 flex flex-col gap-4">
        <form className="flex flex-wrap items-end gap-3" role="search" aria-label="Map filters" onSubmit={(e) => e.preventDefault()}>
          <Field label="Date">{(p) => <Input {...p} type="date" value={date || defaultDate} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label="Rep">
            {(p) => (
              <Select {...p} value={repId} onChange={(e) => setRepId(e.target.value)}>
                <option value="">All reps</option>
                {data.reps.map((r) => (
                  <option key={r.repId} value={r.repId}>
                    {r.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Door status">
            {(p) => (
              <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as DoorStatus | "")}>
                <option value="">Any status</option>
                {DOOR_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {DOOR_STATUS[s].label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </form>
        {error && (
          <p role="alert" className="text-body text-amber-fg">
            {error}
          </p>
        )}
        {mapError ? (
          <div role="status" className="rounded-md border border-line bg-surface p-6 text-body">
            {mapError}
          </div>
        ) : (
          <div ref={container} data-testid="live-map" className="h-[calc(100dvh-260px)] min-h-96 w-full overflow-hidden rounded-md border border-line bg-surface-sunken" />
        )}
      </div>

      <aside className="col-span-5 flex flex-col gap-6" aria-label="Map details">
        <section className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4">
          <h2 className="text-title-s">Needs review</h2>
          {data.reviewCount === 0 ? (
            <p className="text-body text-ink-2">No doors need a decision.</p>
          ) : (
            <p className="text-body">
              {data.reviewCount} {data.reviewCount === 1 ? "door needs" : "doors need"} an address decision.{" "}
              <Link href="/console/review" className="text-link underline underline-offset-4">
                Open the queue
              </Link>
            </p>
          )}
        </section>

        <section className="flex flex-col gap-2" aria-labelledby="reps-today">
          <h2 id="reps-today" className="text-title-m">
            Reps
          </h2>
          {data.reps.length === 0 ? (
            <p className="text-body text-ink-2">No active reps yet.</p>
          ) : (
            <ul className="flex flex-col">
              {data.reps.map((r) => (
                <li key={r.repId} className="flex items-center gap-3 border-b border-line py-2">
                  <button type="button" onClick={() => setSelected((s) => (s === r.repId ? null : r.repId))} aria-pressed={selected === r.repId} className="flex flex-1 flex-col text-left">
                    <span className="text-title-s">{r.name}</span>
                    <span className="tnum text-caption text-ink-2">
                      {r.todayTotal === 0 ? "No stops" : `${r.todayDone} of ${r.todayTotal} done`} · {ago(r.lastLocationAt, clock)}
                    </span>
                  </button>
                  {r.onShift ? <Chip tone="green">On shift</Chip> : <Chip tone="slate">Off shift</Chip>}
                  <Link href={`/console/reps/${r.repId}/day/${r.date}`} className="text-label text-link underline-offset-4 hover:underline">
                    Day board
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {selectedRep && (
          <section className="flex flex-col gap-2" aria-label={`${selectedRep.name}'s route`}>
            <h2 className="text-title-s">{selectedRep.name}&apos;s route</h2>
            <ol className="flex flex-col gap-1 text-body">
              {data.doors
                .filter((d) => d.repId === selectedRep.repId && d.routeOrder !== null)
                .sort((a, b) => a.routeOrder! - b.routeOrder!)
                .map((d) => (
                  <li key={d.doorId} className="flex items-center gap-2">
                    <span className="tnum w-6 font-semibold">{d.routeOrder}</span>
                    <Link href={`/console/doors?door=${d.doorId}`} className="hover:underline">
                      {d.name}
                    </Link>
                    <span className="ml-auto text-caption text-ink-2">{DOOR_STATUS[d.status].label}</span>
                  </li>
                ))}
            </ol>
          </section>
        )}

        <section className="flex flex-col gap-2" aria-label="Legend">
          <h2 className="text-title-s">Door pins</h2>
          <div className="flex flex-wrap gap-2">
            {(["GEOCODED", "ASSIGNED", "SCHEDULED", "VISITED", "UNASSIGNABLE"] as DoorStatus[]).map((s) => (
              <Chip key={s} tone={DOOR_STATUS[s].tone} outlined={"outlined" in DOOR_STATUS[s]}>
                {DOOR_STATUS[s].label}
              </Chip>
            ))}
          </div>
          <p className="text-caption text-ink-2">A solid ring around a rep means a location in the last 15 minutes; dashed means within 2 hours.</p>
        </section>
      </aside>
    </div>
  );
}
