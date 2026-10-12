// In-memory Google clients for tests and for running locally without a key.
import type { GeocodeResult, PlaceCandidate } from "@/lib/domain/addressResolution";
import { estimateDriveMinutes, haversineMeters, type LatLng } from "@/lib/domain/geo";
import { DEFAULT_TRAVEL } from "@/lib/domain/settings";
import type { GoogleClients } from "./index";

export type FakeGoogleOptions = {
  /** Geocode answers by exact query; anything else is ZERO_RESULTS. */
  geocode?: Record<string, GeocodeResult>;
  /** Places results by exact query; anything else is no results. */
  places?: Record<string, PlaceCandidate[]>;
  /** Drive minutes; defaults to the haversine estimate. */
  minutes?: (a: LatLng, b: LatLng) => number;
};

export function fakeGoogle(options: FakeGoogleOptions = {}): GoogleClients & { calls: { api: string; arg: unknown }[] } {
  const calls: { api: string; arg: unknown }[] = [];
  const minutes = options.minutes ?? ((a: LatLng, b: LatLng) => estimateDriveMinutes(a, b, DEFAULT_TRAVEL));
  return {
    calls,
    async geocode(query) {
      calls.push({ api: "geocode", arg: query });
      return options.geocode?.[query] ?? { status: "ZERO_RESULTS" };
    },
    async placesTextSearch(query) {
      calls.push({ api: "places", arg: query });
      return options.places?.[query] ?? [];
    },
    async driveTimes(origins, destination) {
      calls.push({ api: "driveTimes", arg: { origins, destination } });
      return origins.map((o) => minutes(o, destination));
    },
    async routeMatrix(origins, destinations) {
      calls.push({ api: "routeMatrix", arg: { origins, destinations } });
      return origins.map((o) => destinations.map((d) => ({ minutes: minutes(o, d), meters: haversineMeters(o, d) })));
    },
    async optimizeTours() {
      throw new Error("fake optimizeTours: not configured");
    },
  };
}
