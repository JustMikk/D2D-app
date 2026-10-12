import { describe, expect, it, vi } from "vitest";
import { signedMediaUrl, verifyMediaSignature } from "@/lib/integrations/mediaSigning";
import { signPayload, verifySignature, webhookHeaders } from "@/lib/integrations/webhooks";
import { createGeocoder, parseGeocodeResponse } from "@/lib/integrations/google/geocoding";
import { googleRequest, GoogleApiError } from "@/lib/integrations/google/http";
import { createPlacesSearch, parsePlace, PLACES_FIELD_MASK } from "@/lib/integrations/google/places";
import { createRouteMatrix, parseDurationSeconds, parseMatrix } from "@/lib/integrations/google/routeMatrix";
import { buildOptimizeToursRequest, parseOptimizeToursResponse, type OptimizeStop } from "@/lib/integrations/google/routeOptimization";

const SECRET = "s".repeat(40);
const quiet = { log: () => {} };

function respond(status: number, body: unknown) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("webhook signing", () => {
  const body = '{"id":"evt_1","type":"visit.hot"}';
  const now = new Date("2026-10-09T12:00:00Z");

  it("signs HMAC-SHA256 over timestamp.body and verifies", () => {
    const headers = webhookHeaders(SECRET, { id: "evt_1", type: "visit.hot" }, body, now);
    expect(headers).toMatchObject({ "x-canvass-event": "visit.hot", "x-canvass-delivery": "evt_1", "x-canvass-timestamp": "1791547200" });
    expect(headers["x-canvass-signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(headers["x-canvass-signature"]).toBe(signPayload(SECRET, 1791547200, body));
    expect(verifySignature(SECRET, { timestamp: "1791547200", signature: headers["x-canvass-signature"]! }, body, now)).toBe(true);
  });

  it("rejects tampered bodies, wrong secrets and stale timestamps", () => {
    const sig = signPayload(SECRET, 1791547200, body);
    expect(verifySignature(SECRET, { timestamp: "1791547200", signature: sig }, body.replace("hot", "cold"), now)).toBe(false);
    expect(verifySignature("x".repeat(40), { timestamp: "1791547200", signature: sig }, body, now)).toBe(false);
    expect(verifySignature(SECRET, { timestamp: "1791547200", signature: sig }, body, new Date(now.getTime() + 301_000))).toBe(false);
    expect(verifySignature(SECRET, { timestamp: null, signature: sig }, body, now)).toBe(false);
  });
});

describe("signed media URLs", () => {
  it("are valid for 7 days and bound to the media ID", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    const url = new URL(signedMediaUrl("https://canvass.test", SECRET, "m1", now));
    expect(url.pathname).toBe("/api/v1/media/m1");
    const exp = url.searchParams.get("exp");
    const sig = url.searchParams.get("sig");
    expect(verifyMediaSignature(SECRET, "m1", exp, sig, now)).toBe(true);
    expect(verifyMediaSignature(SECRET, "m2", exp, sig, now)).toBe(false);
    expect(verifyMediaSignature(SECRET, "m1", exp, sig, new Date(now.getTime() + 8 * 24 * 3600_000))).toBe(false);
  });
});

describe("googleRequest", () => {
  it("retries once on 5xx, then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(respond(503, "busy")).mockResolvedValueOnce(respond(200, { ok: true }));
    expect(await googleRequest("t", "https://x", {}, { fetch: f, ...quiet })).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not retry 4xx, and gives up after the second 5xx", async () => {
    const f4 = vi.fn().mockResolvedValue(respond(403, "denied"));
    await expect(googleRequest("t", "https://x", {}, { fetch: f4, ...quiet })).rejects.toBeInstanceOf(GoogleApiError);
    expect(f4).toHaveBeenCalledTimes(1);
    const f5 = vi.fn().mockResolvedValue(respond(500, "oops"));
    await expect(googleRequest("t", "https://x", {}, { fetch: f5, ...quiet })).rejects.toMatchObject({ status: 500 });
    expect(f5).toHaveBeenCalledTimes(2);
  });

  it("retries a network error once", async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(respond(200, []));
    expect(await googleRequest("t", "https://x", {}, { fetch: f, ...quiet })).toEqual([]);
  });
});

describe("geocoding", () => {
  it("maps the first result", () => {
    expect(
      parseGeocodeResponse({
        status: "OK",
        results: [{ geometry: { location: { lat: 33.06, lng: -96.8 }, location_type: "ROOFTOP" }, partial_match: true }],
      }),
    ).toEqual({ status: "OK", location: { lat: 33.06, lng: -96.8 }, locationType: "ROOFTOP", partialMatch: true });
    expect(parseGeocodeResponse({ status: "ZERO_RESULTS", results: [] })).toEqual({ status: "ZERO_RESULTS" });
  });

  it("restricts to the US, and throws on quota errors so the job retries", async () => {
    const f = vi.fn().mockResolvedValueOnce(respond(200, { status: "ZERO_RESULTS", results: [] })).mockResolvedValueOnce(respond(200, { status: "OVER_QUERY_LIMIT" }));
    const geocode = createGeocoder("KEY", { fetch: f, ...quiet });
    expect(await geocode("6101 Preston Rd, Plano, TX 75093")).toEqual({ status: "ZERO_RESULTS" });
    expect(f.mock.calls[0]![0]).toContain("address=6101%20Preston%20Rd%2C%20Plano%2C%20TX%2075093&components=country:US&key=KEY");
    await expect(geocode("x")).rejects.toThrow(/OVER_QUERY_LIMIT/);
  });
});

describe("places", () => {
  const place = {
    id: "ChIJ123",
    displayName: { text: "Sunbelt Medical Billing", languageCode: "en" },
    addressComponents: [
      { longText: "3100", shortText: "3100", types: ["street_number"] },
      { longText: "Hemphill Street", shortText: "Hemphill St", types: ["route"] },
      { longText: "Fort Worth", shortText: "Fort Worth", types: ["locality", "political"] },
      { longText: "Texas", shortText: "TX", types: ["administrative_area_level_1", "political"] },
      { longText: "76110", shortText: "76110", types: ["postal_code"] },
    ],
    location: { latitude: 32.71, longitude: -97.33 },
    businessStatus: "OPERATIONAL",
  };

  it("maps address components into a candidate", () => {
    expect(parsePlace(place)).toEqual({
      placeId: "ChIJ123",
      displayName: "Sunbelt Medical Billing",
      streetNumber: "3100",
      route: "Hemphill St",
      locality: "Fort Worth",
      adminArea1: "TX",
      postalCode: "76110",
      businessStatus: "OPERATIONAL",
      location: { lat: 32.71, lng: -97.33 },
    });
  });

  it("sends the field mask, the US region and pageSize 3", async () => {
    const f = vi.fn().mockResolvedValue(respond(200, { places: [place] }));
    const search = createPlacesSearch("KEY", { fetch: f, ...quiet });
    expect(await search("Sunbelt Medical Billing Fort Worth, TX")).toHaveLength(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(init.headers).toMatchObject({ "x-goog-api-key": "KEY", "x-goog-fieldmask": PLACES_FIELD_MASK });
    expect(JSON.parse(init.body)).toEqual({ textQuery: "Sunbelt Medical Billing Fort Worth, TX", regionCode: "US", pageSize: 3 });
    f.mockResolvedValue(respond(200, {}));
    expect(await search("nothing")).toEqual([]);
  });
});

describe("route matrix", () => {
  it("parses durations", () => {
    expect(parseDurationSeconds("1234s")).toBe(1234);
    expect(parseDurationSeconds("0.5s")).toBe(0.5);
    expect(parseDurationSeconds(undefined)).toBeNull();
  });

  it("places elements by index, treating a missing index as 0, and nulls missing routes", () => {
    const grid = parseMatrix(
      [
        { destinationIndex: 1, duration: "600s", distanceMeters: 8000, condition: "ROUTE_EXISTS", status: {} }, // originIndex omitted = 0
        { originIndex: 1, duration: "120s", distanceMeters: 900, condition: "ROUTE_EXISTS" }, // destinationIndex omitted = 0
        { originIndex: 1, destinationIndex: 1, condition: "ROUTE_NOT_FOUND", status: {} },
      ],
      2,
      2,
    );
    expect(grid).toEqual([
      [null, { minutes: 10, meters: 8000 }],
      [{ minutes: 2, meters: 900 }, null],
    ]);
  });

  it("posts waypoints with the field mask", async () => {
    const f = vi.fn().mockResolvedValue(respond(200, [{ duration: "300s", distanceMeters: 4000, condition: "ROUTE_EXISTS" }]));
    const matrix = createRouteMatrix("KEY", { fetch: f, ...quiet });
    expect(await matrix([{ lat: 1, lng: 2 }], [{ lat: 3, lng: 4 }])).toEqual([[{ minutes: 5, meters: 4000 }]]);
    const body = JSON.parse(f.mock.calls[0]![1].body);
    expect(body).toEqual({
      origins: [{ waypoint: { location: { latLng: { latitude: 1, longitude: 2 } } } }],
      destinations: [{ waypoint: { location: { latLng: { latitude: 3, longitude: 4 } } } }],
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
    });
    expect(await matrix([], [{ lat: 3, lng: 4 }])).toEqual([]);
  });
});

describe("route optimization", () => {
  const stops: OptimizeStop[] = [
    { id: "a1", lat: 33, lng: -96.8, hot: true, window: null },
    { id: "a2", lat: 33.1, lng: -96.7, hot: false, window: "AFTERNOON" },
  ];
  const input = {
    start: { lat: 32.9, lng: -96.9 },
    startAt: new Date("2026-10-07T14:00:00Z"),
    timeZone: "America/Chicago",
    date: "2026-10-07",
    dayStartLocal: "09:00",
    stops,
    visitDurationMinutes: 20,
  };

  it("builds one vehicle, one delivery per stop, windows and penalties", () => {
    const req = buildOptimizeToursRequest(input);
    expect(req.model.globalStartTime).toBe("2026-10-07T14:00:00.000Z");
    expect(req.model.vehicles).toEqual([{ label: "rep", startLocation: { latitude: 32.9, longitude: -96.9 }, travelMode: "DRIVING", costPerHour: 60 }]);
    expect(req.model.shipments[0]).toEqual({
      label: "a1",
      penaltyCost: 1_000_000,
      deliveries: [{ arrivalLocation: { latitude: 33, longitude: -96.8 }, duration: "1200s" }],
    });
    expect(req.model.shipments[1]!.deliveries[0]).toMatchObject({
      timeWindows: [{ startTime: "2026-10-07T17:00:00.000Z", endTime: "2026-10-07T22:00:00.000Z" }], // 12:00–17:00 CDT
    });
  });

  it("reads visits in order and skipped shipments, with omitted zero indexes", () => {
    const result = parseOptimizeToursResponse(
      { routes: [{ visits: [{ shipmentIndex: 1, startTime: "2026-10-07T17:00:00Z" }, { startTime: "2026-10-07T18:00:00Z" }] }], skippedShipments: [] },
      stops,
    );
    expect(result.visits.map((v) => v.id)).toEqual(["a2", "a1"]);
    expect(parseOptimizeToursResponse({ routes: [{}], skippedShipments: [{ label: "a2", index: 1 }, {}] }, stops).skipped).toEqual(["a2", "a1"]);
  });
});
