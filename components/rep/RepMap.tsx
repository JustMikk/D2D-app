"use client";
// The route on a map (PRD REP-3): numbered stops, the route line, and the rep's own position. MapLibre GL with
// OpenFreeMap tiles, restyled with the design tokens. If the map can't start (no WebGL, or no signal and no
// cached tiles) the rep gets a plain message; the list always works.
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { bboxOf, DEFAULT_STYLE_URL } from "@/lib/rep/tiles";
import { applyTokenColors } from "@/lib/ui/mapStyle";
import type { TodayStop } from "@/lib/services/repApp";

export type MapStop = Pick<TodayStop, "assignmentId" | "routeOrder" | "status"> & { lat: number; lng: number; hot: boolean; name: string };

function pinElement(stop: MapStop, current: boolean): HTMLElement {
  const done = stop.status !== "ACTIVE";
  const el = document.createElement("button");
  el.type = "button";
  el.setAttribute("aria-label", `Stop ${stop.routeOrder ?? ""}: ${stop.name}${stop.hot ? ", hot" : ""}${done ? ", done" : ""}`);
  const size = current ? "size-9" : "size-7";
  const fill = done ? "bg-slate-solid" : stop.hot ? "bg-hot" : "bg-blue-solid";
  // Every pin carries the 2px ink outline: a yellow or grey fill alone would not read in sunlight.
  el.className = `tnum grid ${size} place-items-center rounded-full border-2 border-outline ${fill} text-label font-bold text-on-action ${stop.hot && !done ? "shadow-[0_0_0_4px_var(--hot)]" : ""}`;
  el.textContent = stop.routeOrder === null ? "" : String(stop.routeOrder);
  return el;
}

export default function RepMap({ stops, me, currentId, onSelect }: { stops: MapStop[]; me: { lat: number; lng: number } | null; currentId: string | null; onSelect: (assignmentId: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const maplibre = await import("maplibre-gl");
        if (cancelled || !container.current) return;
        const map = new maplibre.Map({
          container: container.current,
          style: process.env.NEXT_PUBLIC_MAP_STYLE_URL || DEFAULT_STYLE_URL,
          center: stops[0] ? [stops[0].lng, stops[0].lat] : [-96.8, 32.78],
          zoom: 11,
          attributionControl: { compact: true },
        });
        mapRef.current = map;
        map.on("load", () => {
          applyTokenColors(map);
          map.addSource("route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } } });
          // A 2px casing under a 5px route line, as the design specifies.
          const css = getComputedStyle(document.documentElement);
          map.addLayer({ id: "route-casing", type: "line", source: "route", paint: { "line-color": css.getPropertyValue("--surface").trim(), "line-width": 9 }, layout: { "line-cap": "round", "line-join": "round" } });
          map.addLayer({ id: "route-line", type: "line", source: "route", paint: { "line-color": css.getPropertyValue("--route").trim(), "line-width": 5 }, layout: { "line-cap": "round", "line-join": "round" } });
          setReady(true);
        });
        map.on("error", (e) => {
          // A single missing tile is normal offline; only a failure to load the style itself is fatal.
          if (!map.isStyleLoaded() && !mapRef.current?.loaded()) setError(e.error?.message ?? "The map couldn't load.");
        });
      } catch {
        if (!cancelled) setError("This phone can't show the map.");
      }
    })();
    return () => {
      cancelled = true;
      markers.current.forEach((m) => m.remove());
      markers.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // The map is created once; stops and position update below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    void (async () => {
      const maplibre = await import("maplibre-gl");
      markers.current.forEach((m) => m.remove());
      markers.current = stops.map((s) => {
        const el = pinElement(s, s.assignmentId === currentId);
        el.addEventListener("click", () => onSelect(s.assignmentId));
        return new maplibre.Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(map);
      });
      if (me) {
        const dot = document.createElement("div");
        dot.setAttribute("aria-label", "Your location");
        dot.className = "size-4 rounded-full border-[3px] border-surface bg-route shadow-2";
        markers.current.push(new maplibre.Marker({ element: dot }).setLngLat([me.lng, me.lat]).addTo(map));
      }
      const open = stops.filter((s) => s.status === "ACTIVE").sort((a, b) => (a.routeOrder ?? 0) - (b.routeOrder ?? 0));
      const line = [...(me ? [[me.lng, me.lat]] : []), ...open.map((s) => [s.lng, s.lat])];
      (map.getSource("route") as { setData: (d: unknown) => void } | undefined)?.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } });
      const box = bboxOf([...stops, ...(me ? [me] : [])], 0.005);
      if (box) map.fitBounds([[box.west, box.south], [box.east, box.north]], { padding: 48, duration: 0, maxZoom: 16 });
    })();
  }, [stops, me, currentId, ready, onSelect]);

  if (error) {
    return (
      <div role="status" className="rounded-md border-2 border-outline bg-surface p-4 text-body-l">
        The map isn&apos;t available right now. Use the list to work through your stops.
      </div>
    );
  }
  return <div ref={container} data-testid="route-map" className="h-[60dvh] min-h-80 w-full overflow-hidden rounded-md border-2 border-outline bg-surface-sunken" />;
}
