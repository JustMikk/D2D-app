// Route Optimization optimizeTours (backend spec §6.6, §9.1). Optional provider. It needs an OAuth
// token from a service account: the API does not accept API keys.
import { GoogleAuth } from "google-auth-library";
import type { VisitWindow } from "@/lib/domain/enums";
import type { LatLng } from "@/lib/domain/geo";
import { atLocal } from "@/lib/domain/time";
import { googleRequest, type GoogleHttpOptions } from "./http";

export type OptimizeStop = LatLng & { id: string; hot: boolean; window: VisitWindow | null };

export type OptimizeInput = {
  start: LatLng;
  startAt: Date;
  timeZone: string;
  date: string;
  dayStartLocal: string;
  stops: readonly OptimizeStop[];
  visitDurationMinutes: number;
};

export type OptimizeResult = {
  /** Stops in visiting order with Google's planned start times. */
  visits: { id: string; startTime: Date }[];
  /** Stops Google could not fit; the caller appends them and flags the plan. */
  skipped: string[];
};

/** Penalty for skipping a shipment: high for hot doors so they are never dropped. */
const PENALTY = { hot: 1_000_000, normal: 1_000 };
const DAY_END = "20:00";

function windowBounds(input: OptimizeInput, window: VisitWindow): [Date, Date] {
  const at = (hhmm: string) => atLocal(input.timeZone, input.date, hhmm);
  if (window === "MORNING") return [at(input.dayStartLocal), at("12:00")];
  if (window === "AFTERNOON") return [at("12:00"), at("17:00")];
  return [at("17:00"), at(DAY_END)];
}

export function buildOptimizeToursRequest(input: OptimizeInput) {
  const latLng = (p: LatLng) => ({ latitude: p.lat, longitude: p.lng });
  return {
    model: {
      globalStartTime: input.startAt.toISOString(),
      // Leave room past 20:00 so late stops are planned (and flagged) rather than skipped.
      globalEndTime: atLocal(input.timeZone, input.date, "23:59").toISOString(),
      shipments: input.stops.map((s) => ({
        label: s.id,
        penaltyCost: s.hot ? PENALTY.hot : PENALTY.normal,
        deliveries: [
          {
            arrivalLocation: latLng(s),
            duration: `${input.visitDurationMinutes * 60}s`,
            ...(s.window
              ? { timeWindows: [{ startTime: windowBounds(input, s.window)[0].toISOString(), endTime: windowBounds(input, s.window)[1].toISOString() }] }
              : {}),
          },
        ],
      })),
      vehicles: [{ label: "rep", startLocation: latLng(input.start), travelMode: "DRIVING", costPerHour: 60 }],
    },
  };
}

type OptimizeToursResponse = {
  routes?: Array<{ visits?: Array<{ shipmentIndex?: number; startTime?: string; shipmentLabel?: string }> }>;
  skippedShipments?: Array<{ index?: number; label?: string }>;
};

/** Proto3 JSON omits zero values, so a missing shipmentIndex or index means 0. */
export function parseOptimizeToursResponse(body: OptimizeToursResponse, stops: readonly OptimizeStop[]): OptimizeResult {
  const idAt = (i: number | undefined, label?: string) => label ?? stops[i ?? 0]?.id;
  const visits = (body.routes?.[0]?.visits ?? [])
    .map((v) => ({ id: idAt(v.shipmentIndex, v.shipmentLabel), startTime: new Date(v.startTime ?? 0) }))
    .filter((v): v is { id: string; startTime: Date } => Boolean(v.id));
  const skipped = (body.skippedShipments ?? []).map((s) => idAt(s.index, s.label)).filter((id): id is string => Boolean(id));
  return { visits, skipped };
}

export type TokenProvider = () => Promise<string>;

export function serviceAccountToken(): TokenProvider {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return async () => {
    const token = await auth.getAccessToken();
    if (!token) throw new Error("routeOptimization: could not get an access token from the service account");
    return token;
  };
}

export function createRouteOptimizer(projectId: string, getToken: TokenProvider = serviceAccountToken(), options?: GoogleHttpOptions) {
  return async function optimizeTours(input: OptimizeInput): Promise<OptimizeResult> {
    if (input.stops.length === 0) return { visits: [], skipped: [] };
    const body = await googleRequest<OptimizeToursResponse>(
      "routeOptimization.optimizeTours",
      `https://routeoptimization.googleapis.com/v1/projects/${encodeURIComponent(projectId)}:optimizeTours`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await getToken()}` },
        body: JSON.stringify(buildOptimizeToursRequest(input)),
      },
      { timeoutMs: 30_000, ...options },
    );
    return parseOptimizeToursResponse(body, input.stops);
  };
}
