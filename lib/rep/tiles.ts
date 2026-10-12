// Offline map tiles (PRD §9, offline): at the start of the day the app fetches the tiles around today's
// route, so the service worker has them when the signal drops. Pure tile math plus a best-effort prefetcher.
export type BBox = { west: number; south: number; east: number; north: number };

export const DEFAULT_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

/** Web-mercator tile coordinates for a point at a zoom level. */
export function lngLatToTile(lng: number, lat: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const x = Math.floor(((lng + 180) / 360) * n);
  const rad = (clampedLat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

export function bboxOf(points: { lat: number; lng: number }[], paddingDeg = 0.02): BBox | null {
  if (points.length === 0) return null;
  return {
    west: Math.min(...points.map((p) => p.lng)) - paddingDeg,
    east: Math.max(...points.map((p) => p.lng)) + paddingDeg,
    south: Math.min(...points.map((p) => p.lat)) - paddingDeg,
    north: Math.max(...points.map((p) => p.lat)) + paddingDeg,
  };
}

/** Every tile covering the box at each zoom, stopping before `limit` tiles in total (the lowest zooms first). */
export function tilesForBbox(box: BBox, zooms: number[], limit = 300): { z: number; x: number; y: number }[] {
  const out: { z: number; x: number; y: number }[] = [];
  for (const z of [...zooms].sort((a, b) => a - b)) {
    const a = lngLatToTile(box.west, box.north, z);
    const b = lngLatToTile(box.east, box.south, z);
    const count = (b.x - a.x + 1) * (b.y - a.y + 1);
    if (out.length + count > limit) break;
    for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) out.push({ z, x, y });
  }
  return out;
}

type StyleJson = { sources?: Record<string, { type?: string; url?: string; tiles?: string[] }> };

/** Fetch the tiles for a route. Errors are swallowed: a missing tile just means a blank patch offline. */
export async function prefetchRouteTiles(points: { lat: number; lng: number }[], styleUrl = DEFAULT_STYLE_URL, doFetch: typeof fetch = fetch): Promise<number> {
  const box = bboxOf(points);
  if (!box) return 0;
  try {
    const style = (await (await doFetch(styleUrl)).json()) as StyleJson;
    const vector = Object.values(style.sources ?? {}).find((s) => s.type === "vector");
    if (!vector) return 0;
    const templates = vector.tiles ?? (vector.url ? (((await (await doFetch(vector.url)).json()) as { tiles?: string[] }).tiles ?? []) : []);
    const template = templates[0];
    if (!template) return 0;
    const tiles = tilesForBbox(box, [11, 12, 13, 14, 15]);
    let done = 0;
    // Six at a time, so a rep on a weak connection is not starved by the prefetch.
    for (let i = 0; i < tiles.length; i += 6) {
      const batch = tiles.slice(i, i + 6);
      await Promise.all(
        batch.map((t) =>
          doFetch(template.replace("{z}", String(t.z)).replace("{x}", String(t.x)).replace("{y}", String(t.y)))
            .then(() => void done++)
            .catch(() => undefined),
        ),
      );
    }
    return done;
  } catch {
    return 0;
  }
}
