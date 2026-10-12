import type { TravelSettings } from "./settings";

export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_M = 6_371_008.8;
const METERS_PER_MILE = 1609.344;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in meters. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function haversineMiles(a: LatLng, b: LatLng): number {
  return haversineMeters(a, b) / METERS_PER_MILE;
}

export function milesToMeters(miles: number): number {
  return miles * METERS_PER_MILE;
}

/** Drive-time estimate when no matrix is available: miles × roadFactor / avgSpeedMph × 60 (backend spec §6.4). */
export function estimateDriveMinutes(a: LatLng, b: LatLng, travel: TravelSettings): number {
  return (haversineMiles(a, b) * travel.roadFactor * 60) / travel.avgSpeedMph;
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
