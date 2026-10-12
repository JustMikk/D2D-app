// Time-zone utilities (backend spec §6.8). All local-day math goes through Luxon; never Date arithmetic.
import { DateTime } from "luxon";
import { WEEKDAYS, type Weekday } from "./enums";

/** How far ahead a workday search may look before giving up (backend spec §6.5). */
export const MAX_WORKDAY_SEARCH_DAYS = 14;

export type WorkdayCalendar = {
  /** Working weekdays, e.g. ["MON", …, "SAT"]. */
  workdays: readonly Weekday[];
  /** Local dates (YYYY-MM-DD) the rep is unavailable. */
  unavailableDates?: readonly string[];
};

function zoned(tz: string, now: Date): DateTime {
  const dt = DateTime.fromJSDate(now, { zone: tz });
  if (!dt.isValid) throw new Error(`Invalid time zone: ${tz}`);
  return dt;
}

function parseDate(date: string, tz = "UTC"): DateTime {
  const dt = DateTime.fromISO(date, { zone: tz });
  if (!dt.isValid || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid local date: ${date}`);
  return dt;
}

/** The local calendar date (YYYY-MM-DD) in `tz` at instant `now`. */
export function localToday(tz: string, now: Date): string {
  return zoned(tz, now).toISODate()!;
}

/** The local wall-clock time (HH:mm) in `tz` at instant `now`. */
export function localTime(tz: string, now: Date): string {
  return zoned(tz, now).toFormat("HH:mm");
}

export function localDateOf(utc: Date, tz: string): string {
  return localToday(tz, utc);
}

/** The UTC instant of local `HH:mm` on `date` in `tz`. Times inside a DST gap move forward, as Luxon does. */
export function atLocal(tz: string, date: string, hhmm: string): Date {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Invalid HH:mm: ${hhmm}`);
  const dt = parseDate(date, tz).set({ hour: Number(m[1]), minute: Number(m[2]), second: 0, millisecond: 0 });
  return dt.toJSDate();
}

export function addDays(date: string, days: number): string {
  return parseDate(date).plus({ days }).toISODate()!;
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[parseDate(date).weekday - 1]!;
}

/** Parse the stored "MON,TUE,…" form. Unknown codes are ignored. */
export function parseWorkdays(csv: string): Weekday[] {
  return csv
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is Weekday => (WEEKDAYS as readonly string[]).includes(s));
}

export function isWorkday(rep: WorkdayCalendar, date: string): boolean {
  return rep.workdays.includes(weekdayOf(date)) && !(rep.unavailableDates ?? []).includes(date);
}

/** The first workday strictly after `from`, within the search limit. Throws when there is none. */
export function nextWorkday(rep: WorkdayCalendar, from: string): string {
  for (let i = 1; i <= MAX_WORKDAY_SEARCH_DAYS; i++) {
    const d = addDays(from, i);
    if (isWorkday(rep, d)) return d;
  }
  throw new Error(`No workday within ${MAX_WORKDAY_SEARCH_DAYS} days after ${from}`);
}

/** `from` itself when it is a workday, otherwise the next one. */
export function workdayOnOrAfter(rep: WorkdayCalendar, from: string): string {
  return isWorkday(rep, from) ? from : nextWorkday(rep, from);
}

/** True for IANA zone names Luxon understands, e.g. "America/Chicago". */
export function isValidTimeZone(tz: string): boolean {
  return DateTime.now().setZone(tz).isValid;
}

/** Compare "HH:mm" strings. */
export function compareHHmm(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
