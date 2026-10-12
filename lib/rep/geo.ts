"use client";
// The phone's location (PRD REP-8). A fix is requested only at the moments the spec names: start and end of
// the day, arriving, saving a visit, and every couple of minutes while a shift is on and the app is open.
import type { Fix } from "./outbox";

export type FixResult = { fix: Fix | null; denied: boolean };

/** One GPS reading, or null when it is denied, unavailable or too slow. Never throws. */
export function getFix(timeoutMs = 6000, maximumAgeMs = 30_000): Promise<FixResult> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve({ fix: null, denied: false });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ fix: { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy, capturedAt: new Date(p.timestamp).toISOString() }, denied: false }),
      (e) => resolve({ fix: null, denied: e.code === e.PERMISSION_DENIED }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: maximumAgeMs },
    );
  });
}
