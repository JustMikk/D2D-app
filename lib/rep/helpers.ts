// Small pure helpers for the rep app: maps links, image sizing, the next-step timestamp.
import { DateTime } from "luxon";

export type MapsApp = "apple" | "google";

/** The link that opens turn-by-turn directions in the rep's chosen maps app (PRD REP-4). */
export function navigateUrl(app: MapsApp, lat: number, lng: number): string {
  return app === "apple" ? `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d` : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
}

/** Scale (w, h) down to fit within `max` on the longer side. Never scales up. */
export function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** "2026-10-09" and "10:30" in the rep's time zone, as the UTC instant the server stores. */
export function nextStepIso(date: string, time: string, timeZone: string): string | null {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: timeZone });
  return dt.isValid ? dt.toUTC().toISO() : null;
}

/** A UUID for an action. crypto.randomUUID needs a secure context, which an installed PWA always has. */
export function newClientId(): string {
  return crypto.randomUUID();
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1609.344).toFixed(1)} mi`;
}

/** Local clock time in the rep's zone: "10:40 AM". */
export function clockTime(iso: string | null, timeZone: string): string {
  return iso ? DateTime.fromISO(iso, { zone: timeZone }).toFormat("h:mm a") : "—";
}
