import { describe, expect, it } from "vitest";
import { isDusk, sunEvents } from "@/lib/ui/sunset";

const DALLAS = { lat: 32.7767, lng: -96.797 };
const minutesBetween = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 60_000;

describe("sun events", () => {
  // Reference values from api.sunrise-sunset.org for Dallas on 7 October 2026: sunrise 12:24:26Z, solar noon 18:14:55Z, sunset 00:05:24Z on the 8th.
  it("matches a published sunrise, solar noon and sunset for Dallas to within a few minutes", () => {
    const e = sunEvents(new Date("2026-10-07T18:00:00Z"), DALLAS.lat, DALLAS.lng);
    expect(minutesBetween(e.sunrise!, new Date("2026-10-07T12:24:26Z"))).toBeLessThan(4);
    expect(minutesBetween(e.transit, new Date("2026-10-07T18:14:55Z"))).toBeLessThan(4);
    expect(minutesBetween(e.sunset!, new Date("2026-10-08T00:05:24Z"))).toBeLessThan(4);
    expect(e.polar).toBeNull();
  });

  it("matches Seattle in midsummer (sunrise 05:10 PDT, sunset 21:11 PDT on 21 June 2026)", () => {
    const e = sunEvents(new Date("2026-06-21T20:00:00Z"), 47.6062, -122.3321);
    expect(minutesBetween(e.sunrise!, new Date("2026-06-21T12:10:00Z"))).toBeLessThan(6);
    expect(minutesBetween(e.sunset!, new Date("2026-06-22T04:11:00Z"))).toBeLessThan(6);
  });

  it("reports polar day and polar night instead of times", () => {
    expect(sunEvents(new Date("2026-06-21T12:00:00Z"), 80, 0)).toMatchObject({ sunrise: null, sunset: null, polar: "day" });
    expect(sunEvents(new Date("2026-12-21T12:00:00Z"), 80, 0)).toMatchObject({ sunrise: null, sunset: null, polar: "night" });
  });
});

describe("isDusk", () => {
  const dusk = (iso: string, p = DALLAS) => isDusk(new Date(iso), p.lat, p.lng);

  it("is dusk from sunset until sunrise, across the UTC date change", () => {
    expect(dusk("2026-10-07T11:00:00Z")).toBe(true); // 06:00 CDT, before sunrise
    expect(dusk("2026-10-07T13:00:00Z")).toBe(false); // 08:00 CDT
    expect(dusk("2026-10-07T18:00:00Z")).toBe(false); // 13:00 CDT
    expect(dusk("2026-10-07T23:50:00Z")).toBe(false); // 18:50 CDT, 15 minutes before sunset
    expect(dusk("2026-10-08T00:30:00Z")).toBe(true); // 19:30 CDT, after sunset, though UTC says the 8th
    expect(dusk("2026-10-08T05:00:00Z")).toBe(true); // midnight
  });

  it("follows the season: 19:30 is still daylight in Seattle in June, dusk in Dallas in December", () => {
    expect(dusk("2026-06-22T02:30:00Z", { lat: 47.6062, lng: -122.3321 })).toBe(false); // 19:30 PDT
    expect(dusk("2026-12-15T01:30:00Z")).toBe(true); // 19:30 CST
  });

  it("handles the poles: daylight all day in summer, dark all day in winter", () => {
    expect(isDusk(new Date("2026-06-21T00:00:00Z"), 80, 0)).toBe(false);
    expect(isDusk(new Date("2026-12-21T12:00:00Z"), 80, 0)).toBe(true);
  });
});
