// Target date for a new assignment (backend spec §6.5, PRD ASN-2).
import type { Priority } from "./enums";
import { compareHHmm, isWorkday, localTime, localToday, nextWorkday, type WorkdayCalendar } from "./time";

export type TargetDateRep = WorkdayCalendar & { timeZone: string; onShift: boolean };

/**
 * Today when the door is hot and the rep is on shift on a workday, or when the door arrives before
 * the cutoff on a workday. Otherwise the rep's next workday (at most 14 days ahead).
 */
export function targetDate(rep: TargetDateRep, door: { priority: Priority }, nowUtc: Date, cutoffLocalTime: string): string {
  const today = localToday(rep.timeZone, nowUtc);
  const workToday = isWorkday(rep, today);
  if (door.priority === "HOT" && rep.onShift && workToday) return today;
  if (workToday && compareHHmm(localTime(rep.timeZone, nowUtc), cutoffLocalTime) < 0) return today;
  return nextWorkday(rep, today);
}
