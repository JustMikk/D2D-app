// Geocoding API → GeocodeResult (backend spec §9.1).
import type { GeocodeLocationType, GeocodeResult } from "@/lib/domain/addressResolution";
import { googleRequest, type GoogleHttpOptions } from "./http";

type GeocodeResponse = {
  status: string;
  error_message?: string;
  results?: Array<{
    geometry?: { location?: { lat: number; lng: number }; location_type?: string };
    partial_match?: boolean;
  }>;
};

const LOCATION_TYPES = new Set(["ROOFTOP", "RANGE_INTERPOLATED", "GEOMETRIC_CENTER", "APPROXIMATE"]);

export function parseGeocodeResponse(body: GeocodeResponse): GeocodeResult {
  const first = body.results?.[0];
  if (body.status !== "OK" || !first?.geometry?.location) return { status: body.status };
  const type = first.geometry.location_type;
  return {
    status: "OK",
    location: { lat: first.geometry.location.lat, lng: first.geometry.location.lng },
    locationType: type && LOCATION_TYPES.has(type) ? (type as GeocodeLocationType) : undefined,
    partialMatch: first.partial_match === true,
  };
}

/** Statuses that mean "try again later" rather than "this address has no answer". */
const RETRYABLE = new Set(["OVER_QUERY_LIMIT", "UNKNOWN_ERROR", "REQUEST_DENIED"]);

export function createGeocoder(apiKey: string, options?: GoogleHttpOptions) {
  return async function geocode(query: string): Promise<GeocodeResult> {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&components=country:US&key=${encodeURIComponent(apiKey)}`;
    const body = await googleRequest<GeocodeResponse>("geocoding", url, { method: "GET" }, options);
    // Quota and key problems must fail the job (so it retries), not send the door to review.
    if (RETRYABLE.has(body.status)) throw new Error(`geocoding: ${body.status} ${body.error_message ?? ""}`.trim());
    return parseGeocodeResponse(body);
  };
}
