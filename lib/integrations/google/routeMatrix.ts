// Routes API computeRouteMatrix (backend spec §9.1): drive times for assignment (many origins → one door)
// and, with routing.useRouteMatrix (P1), the N×N matrix for the local route provider.
import type { DriveTimesFn } from "@/lib/domain/assignment";
import type { LatLng } from "@/lib/domain/geo";
import { googleRequest, type GoogleHttpOptions } from "./http";

export const MATRIX_FIELD_MASK = "originIndex,destinationIndex,duration,distanceMeters,status,condition";

type MatrixElement = {
  originIndex?: number;
  destinationIndex?: number;
  duration?: string;
  distanceMeters?: number;
  status?: { code?: number; message?: string };
  condition?: string;
};

export type MatrixCell = { minutes: number; meters: number } | null;

/** "1234s" → seconds. */
export function parseDurationSeconds(duration: string | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(duration ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * Elements arrive in any order. Proto3 JSON may omit zero values, so a missing index means 0.
 * A cell is null when Google reports no route or an error for that pair.
 */
export function parseMatrix(elements: MatrixElement[], origins: number, destinations: number): MatrixCell[][] {
  const grid: MatrixCell[][] = Array.from({ length: origins }, () => Array.from({ length: destinations }, () => null));
  for (const el of elements) {
    const o = el.originIndex ?? 0;
    const d = el.destinationIndex ?? 0;
    const seconds = parseDurationSeconds(el.duration);
    const ok = (el.condition === undefined || el.condition === "ROUTE_EXISTS") && !el.status?.code && seconds !== null;
    if (grid[o] && d < destinations) grid[o]![d] = ok ? { minutes: seconds! / 60, meters: el.distanceMeters ?? 0 } : null;
  }
  return grid;
}

const waypoint = (p: LatLng) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });

export function createRouteMatrix(apiKey: string, options?: GoogleHttpOptions) {
  return async function computeRouteMatrix(origins: LatLng[], destinations: LatLng[]): Promise<MatrixCell[][]> {
    if (origins.length === 0 || destinations.length === 0) return [];
    const elements = await googleRequest<MatrixElement[]>(
      "routes.computeRouteMatrix",
      "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey, "x-goog-fieldmask": MATRIX_FIELD_MASK },
        body: JSON.stringify({
          origins: origins.map(waypoint),
          destinations: destinations.map(waypoint),
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_UNAWARE",
        }),
      },
      options,
    );
    return parseMatrix(elements, origins.length, destinations.length);
  };
}

/** Adapter for the assignment engine: minutes from each origin to one destination. */
export function driveTimesFrom(matrix: ReturnType<typeof createRouteMatrix>): DriveTimesFn {
  return async (origins, destination) => (await matrix(origins, [destination])).map((row) => row[0]?.minutes ?? null);
}
