import { describe, expect, it, vi } from "vitest";
import { bboxOf, lngLatToTile, prefetchRouteTiles, tilesForBbox } from "@/lib/rep/tiles";
import { freshnessOf, initialsOf } from "@/lib/services/mapLive";

describe("tile math", () => {
  it("matches the standard web-mercator tile numbers", () => {
    // Dallas at zoom 10, worked by hand: x = floor((-96.797 + 180) / 360 * 1024) = 236, y = floor(0.4035 * 1024) = 413.
    expect(lngLatToTile(-96.797, 32.7767, 10)).toEqual({ x: 236, y: 413 });
    expect(lngLatToTile(0, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(lngLatToTile(-180, 85, 3)).toEqual({ x: 0, y: 0 });
    expect(lngLatToTile(179.99, -85, 3)).toEqual({ x: 7, y: 7 });
  });

  it("pads the box around the stops and has none for an empty route", () => {
    expect(bboxOf([])).toBeNull();
    const box = bboxOf([{ lat: 32.8, lng: -96.9 }, { lat: 32.7, lng: -96.7 }], 0.01)!;
    expect(box.west).toBeCloseTo(-96.91, 6);
    expect(box.east).toBeCloseTo(-96.69, 6);
    expect(box.south).toBeCloseTo(32.69, 6);
    expect(box.north).toBeCloseTo(32.81, 6);
  });

  it("covers the box at each zoom and stops before the tile limit", () => {
    const box = bboxOf([{ lat: 32.78, lng: -96.8 }], 0.02)!;
    const tiles = tilesForBbox(box, [12, 11, 13]);
    expect(tiles.map((t) => t.z)).toEqual([...tiles.map((t) => t.z)].sort((a, b) => a - b)); // lowest zoom first
    expect(new Set(tiles.map((t) => t.z))).toEqual(new Set([11, 12, 13]));
    expect(tiles.every((t, i, all) => all.findIndex((o) => o.z === t.z && o.x === t.x && o.y === t.y) === i)).toBe(true);
    const capped = tilesForBbox(box, [11, 12, 13, 14, 15], 10);
    expect(capped.length).toBeLessThanOrEqual(10);
    expect(Math.max(...capped.map((t) => t.z))).toBeLessThan(15);
  });
});

describe("prefetchRouteTiles", () => {
  it("reads the style, finds the tile template and fetches the tiles, six at a time", async () => {
    const urls: string[] = [];
    const doFetch = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith("/style")) return new Response(JSON.stringify({ sources: { omt: { type: "vector", url: "https://tiles.example/tilejson" } } }));
      if (url.endsWith("/tilejson")) return new Response(JSON.stringify({ tiles: ["https://tiles.example/{z}/{x}/{y}.pbf"] }));
      return new Response("tile");
    }) as unknown as typeof fetch;
    const n = await prefetchRouteTiles([{ lat: 32.78, lng: -96.8 }], "https://tiles.example/style", doFetch);
    expect(n).toBeGreaterThan(10);
    const tileUrls = urls.filter((u) => u.endsWith(".pbf"));
    expect(tileUrls).toHaveLength(n);
    expect(tileUrls[0]).toMatch(/^https:\/\/tiles\.example\/11\/\d+\/\d+\.pbf$/);
  });

  it("gives up quietly when the style cannot be read (offline)", async () => {
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await prefetchRouteTiles([{ lat: 1, lng: 2 }], "https://tiles.example/style", down)).toBe(0);
    expect(await prefetchRouteTiles([], "https://tiles.example/style", down)).toBe(0);
  });
});

describe("rep marker freshness", () => {
  const now = new Date("2026-10-07T15:00:00Z");
  const ago = (m: number) => new Date(now.getTime() - m * 60_000);
  it("is fresh under 15 minutes, aging up to 2 hours, then stale; none without a location", () => {
    expect(freshnessOf(ago(0), now)).toBe("FRESH");
    expect(freshnessOf(ago(14), now)).toBe("FRESH");
    expect(freshnessOf(ago(15), now)).toBe("AGING");
    expect(freshnessOf(ago(120), now)).toBe("AGING");
    expect(freshnessOf(ago(121), now)).toBe("STALE");
    expect(freshnessOf(null, now)).toBe("NONE");
  });
  it("makes initials from the first and last name", () => {
    expect(initialsOf("Jordan Rivera")).toBe("JR");
    expect(initialsOf("  maria  de la cruz ")).toBe("MC");
    expect(initialsOf("Cher")).toBe("C");
  });
});
