// Assignment engine (backend spec §6.4, PRD ASN-1, ASN-2, ASN-6). Pure: drive times are injected,
// and each rep carries its own load per local date.
import type { Priority } from "./enums";
import { chunks, estimateDriveMinutes, haversineMiles, type LatLng } from "./geo";
import type { ReviewEvidence } from "./addressResolution";
import type { TravelSettings } from "./settings";
import { targetDate } from "./targetDate";
import { addDays, isWorkday, localDateOf, localToday, MAX_WORKDAY_SEARCH_DAYS, workdayOnOrAfter, type WorkdayCalendar } from "./time";

export type AssignableRep = WorkdayCalendar & {
  id: string;
  name: string;
  active: boolean;
  timeZone: string;
  onShift: boolean;
  dailyCapacity: number;
  /** Deployment base, or null when none is set. */
  base: LatLng | null;
  /** Last known location. */
  last: (LatLng & { at: Date }) | null;
  /** ACTIVE + COMPLETED assignments per local date (YYYY-MM-DD). Missing dates count as 0. */
  load: Readonly<Record<string, number>>;
};

export type AssignableDoor = LatLng & {
  id: string;
  priority: Priority;
  /** A follow-up or appointment being re-visited (ASN-6). */
  isRevisit?: boolean;
  nextStepAt?: Date | null;
  preferredRepId?: string | null;
};

export type AssignmentSettings = TravelSettings & {
  maxDriveMinutes: number;
  shortlistSize: number;
  cutoffLocalTime: string;
  locationStalenessMinutes: number;
};

/** Drive minutes from each origin to the destination, in order. null entries fall back to the estimate. */
export type DriveTimesFn = (origins: LatLng[], destination: LatLng) => Promise<Array<number | null>>;

export type AssignmentDecision =
  | {
      kind: "assign";
      repId: string;
      date: string;
      driveMinutes: number;
      /** The date is the rep's local today (re-plan the route, push for hot doors). */
      isToday: boolean;
      /** Capacity was ignored (revisits). */
      overCapacity: boolean;
    }
  | { kind: "review"; reason: "COVERAGE_GAP"; evidence: ReviewEvidence }
  | { kind: "unassignable" };

/** The rep's last location when on shift and fresh enough, otherwise the deployment base. */
export function originFor(rep: AssignableRep, now: Date, stalenessMinutes: number): LatLng | null {
  if (rep.onShift && rep.last && now.getTime() - rep.last.at.getTime() <= stalenessMinutes * 60_000) {
    return { lat: rep.last.lat, lng: rep.last.lng };
  }
  return rep.base;
}

function loadOn(rep: AssignableRep, date: string): number {
  return rep.load[date] ?? 0;
}

type Evaluated = { rep: AssignableRep; minutes: number };

export async function assignDoor(
  door: AssignableDoor,
  reps: readonly AssignableRep[],
  now: Date,
  settings: AssignmentSettings,
  driveTimes: DriveTimesFn,
): Promise<AssignmentDecision> {
  const active = reps.filter((r) => r.active);
  if (active.length === 0) return { kind: "unassignable" };

  const withOrigin = active
    .map((rep) => ({ rep, origin: originFor(rep, now, settings.locationStalenessMinutes) }))
    .filter((x): x is { rep: AssignableRep; origin: LatLng } => x.origin !== null);

  // Revisits go to the preferred rep on the next-step date (or their next workday), ignoring capacity.
  if (door.isRevisit && door.preferredRepId) {
    const preferred = active.find((r) => r.id === door.preferredRepId);
    if (preferred) {
      const today = localToday(preferred.timeZone, now);
      const stepDate = door.nextStepAt ? localDateOf(door.nextStepAt, preferred.timeZone) : today;
      const date = workdayOnOrAfter(preferred, stepDate < today ? today : stepDate);
      const origin = originFor(preferred, now, settings.locationStalenessMinutes);
      return {
        kind: "assign",
        repId: preferred.id,
        date,
        driveMinutes: Math.round(origin ? estimateDriveMinutes(origin, door, settings) : 0),
        isToday: date === today,
        overCapacity: loadOn(preferred, date) >= preferred.dailyCapacity,
      };
    }
  }

  if (withOrigin.length === 0) return { kind: "unassignable" };

  const ordered = [...withOrigin].sort((a, b) => haversineMiles(a.origin, door) - haversineMiles(b.origin, door));
  const evaluated: Evaluated[] = [];

  for (const batch of chunks(ordered, Math.max(1, settings.shortlistSize))) {
    let minutes: Array<number | null>;
    try {
      minutes = await driveTimes(batch.map((b) => b.origin), door);
    } catch {
      minutes = batch.map(() => null);
    }
    const scored = batch
      .map((b, i) => ({ rep: b.rep, minutes: minutes[i] ?? estimateDriveMinutes(b.origin, door, settings) }))
      .sort((a, b) => a.minutes - b.minutes);
    evaluated.push(...scored);

    // Only reps within driving range compete for the door. A full rep in range beats a rep with room
    // who is too far away (the door overflows to the next day instead of becoming a coverage gap).
    for (const { rep, minutes: m } of scored) {
      if (m > settings.maxDriveMinutes) continue;
      const date = safeTargetDate(rep, door, now, settings.cutoffLocalTime);
      if (date && loadOn(rep, date) < rep.dailyCapacity) return decision(rep, date, m, now);
    }
  }

  // Everyone in range is full on their target date: the fastest in-range rep on a later workday with room.
  evaluated.sort((a, b) => a.minutes - b.minutes);
  for (const { rep, minutes: m } of evaluated) {
    if (m > settings.maxDriveMinutes) break;
    const first = safeTargetDate(rep, door, now, settings.cutoffLocalTime);
    if (!first) continue;
    for (let i = 1; i <= MAX_WORKDAY_SEARCH_DAYS; i++) {
      const date = addDays(first, i);
      if (!isWorkday(rep, date) || loadOn(rep, date) >= rep.dailyCapacity) continue;
      return decision(rep, date, m, now);
    }
  }

  // Nobody is in range: a coverage gap, naming the nearest rep by drive time.
  const nearest = evaluated[0];
  return nearest ? coverageGap(nearest.rep, nearest.minutes, settings) : { kind: "unassignable" };
}

/** targetDate throws when a rep has no workday in the next 14 days; such a rep simply cannot take the door. */
function safeTargetDate(rep: AssignableRep, door: AssignableDoor, now: Date, cutoff: string): string | null {
  try {
    return targetDate(rep, door, now, cutoff);
  } catch {
    return null;
  }
}

function decision(rep: AssignableRep, date: string, minutes: number, now: Date): AssignmentDecision {
  return {
    kind: "assign",
    repId: rep.id,
    date,
    driveMinutes: Math.round(minutes),
    isToday: date === localToday(rep.timeZone, now),
    overCapacity: false,
  };
}

function coverageGap(rep: AssignableRep, minutes: number, settings: AssignmentSettings): AssignmentDecision {
  return {
    kind: "review",
    reason: "COVERAGE_GAP",
    evidence: {
      coverage: {
        nearestRepId: rep.id,
        nearestRepName: rep.name,
        driveMinutes: Math.round(minutes),
        maxDriveMinutes: settings.maxDriveMinutes,
      },
    },
  };
}
