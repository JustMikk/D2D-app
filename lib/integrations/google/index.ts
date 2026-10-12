// Google clients built from the environment. Jobs call google() at run time, so a missing key fails
// the job with a clear message (and it retries) instead of crashing the worker at boot.
import type { ResolutionDeps } from "@/lib/domain/addressResolution";
import type { DriveTimesFn } from "@/lib/domain/assignment";
import { cityFakeGoogle } from "./cityFake";
import { createGeocoder } from "./geocoding";
import { createPlacesSearch } from "./places";
import { createRouteMatrix, driveTimesFrom, type MatrixCell } from "./routeMatrix";
import { createRouteOptimizer, type OptimizeInput, type OptimizeResult } from "./routeOptimization";

export type GoogleClients = ResolutionDeps & {
  driveTimes: DriveTimesFn;
  routeMatrix: (origins: { lat: number; lng: number }[], destinations: { lat: number; lng: number }[]) => Promise<MatrixCell[][]>;
  optimizeTours: (input: OptimizeInput) => Promise<OptimizeResult>;
};

let override: GoogleClients | null = null;

/** Tests (and local runs without a key) install fakes here. */
export function setGoogleClients(clients: GoogleClients | null): void {
  override = clients;
}

export function google(): GoogleClients {
  if (override) return override;
  if (process.env.CANVASS_FAKE_GOOGLE === "1") {
    // Local demos and e2e runs only: a production build is allowed the fake only on localhost.
    const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(process.env.APP_BASE_URL ?? "");
    if (process.env.NODE_ENV === "production" && !local) throw new Error("CANVASS_FAKE_GOOGLE is for local demos only and is refused in production.");
    return cityFakeGoogle();
  }
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY is not set; geocoding, Places and drive times are unavailable.");
  const matrix = createRouteMatrix(key);
  return {
    geocode: createGeocoder(key),
    placesTextSearch: createPlacesSearch(key),
    driveTimes: driveTimesFrom(matrix),
    routeMatrix: matrix,
    optimizeTours: async (input) => {
      const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
      if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT_ID is not set; the Google route provider is unavailable.");
      return createRouteOptimizer(projectId)(input);
    },
  };
}
