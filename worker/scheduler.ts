// Scheduler (backend spec §8.3), ticking every 60 seconds. Each check is "at or after the time, and not
// done yet", so a worker that was down catches up on its next tick. "Done" is tracked by Job.key, which
// survives completion (dedupeKey is cleared when a job finishes).
import { db } from "@/lib/db";
import type { Weekday } from "@/lib/domain/enums";
import type { SettingsMap } from "@/lib/domain/settings";
import { compareHHmm, isWorkday, localTime, localToday, parseWorkdays } from "@/lib/domain/time";
import { enqueue, type JobPayload, type JobType } from "@/lib/jobs";
import { getSettings } from "@/lib/settings";

export type ScheduleRep = { id: string; timeZone: string; workdays: readonly Weekday[]; unavailableDates: readonly string[] };

export type PlannedJob = { [T in JobType]: { type: T; payload: JobPayload<T>; key: string } }[JobType];

export type ScheduleInput = {
  now: Date;
  reps: readonly ScheduleRep[];
  settings: Pick<SettingsMap, "schedule.routePlanLocalTime" | "schedule.rolloverLocalTime" | "schedule.digestTime" | "schedule.digestTimeZone">;
  serverTimeZone: string;
  /** Daily maintenance time in the server's zone. */
  maintenanceLocalTime?: string;
};

const atOrAfter = (tz: string, now: Date, hhmm: string) => compareHHmm(localTime(tz, now), hhmm) >= 0;

/** Everything that is due now, before filtering out work that already ran. Pure, for tests. */
export function dueJobs(input: ScheduleInput): PlannedJob[] {
  const { now, settings } = input;
  const jobs: PlannedJob[] = [];

  for (const rep of input.reps) {
    const date = localToday(rep.timeZone, now);
    if (isWorkday(rep, date) && atOrAfter(rep.timeZone, now, settings["schedule.routePlanLocalTime"])) {
      jobs.push({ type: "route.plan", payload: { repId: rep.id, date, trigger: "SCHEDULED" }, key: `plan:${rep.id}:${date}:scheduled` });
    }
    // Rollover runs every day, workday or not: a rep may still be on shift, and revisits are set up for tomorrow.
    if (atOrAfter(rep.timeZone, now, settings["schedule.rolloverLocalTime"])) {
      jobs.push({ type: "rollover.rep", payload: { repId: rep.id, date }, key: `rollover:${rep.id}:${date}` });
    }
  }

  const digestTz = settings["schedule.digestTimeZone"];
  if (atOrAfter(digestTz, now, settings["schedule.digestTime"])) {
    const date = localToday(digestTz, now);
    jobs.push({ type: "digest.send", payload: { date }, key: `digest:${date}` });
  }

  const maintenance = input.maintenanceLocalTime ?? "03:00";
  if (atOrAfter(input.serverTimeZone, now, maintenance)) {
    const date = localToday(input.serverTimeZone, now);
    jobs.push({ type: "retention.cleanup", payload: {}, key: `retention:${date}` });
    jobs.push({ type: "unassignable.retry", payload: {}, key: `unassignable-retry:${date}` });
  }
  return jobs;
}

export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * One scheduler tick: enqueue due work that has no job with the same key yet. Only job types with a
 * registered handler are scheduled, so features land in the schedule as their handlers do.
 */
export async function schedulerTick(enabledTypes: ReadonlySet<JobType>, now = new Date()): Promise<PlannedJob[]> {
  const settings = await getSettings();
  const reps = await db().rep.findMany({ where: { active: true }, include: { unavailability: { select: { date: true } } } });
  const due = dueJobs({
    now,
    settings,
    serverTimeZone: serverTimeZone(),
    reps: reps.map((r) => ({ id: r.id, timeZone: r.timeZone, workdays: parseWorkdays(r.workdays), unavailableDates: r.unavailability.map((u) => u.date) })),
  }).filter((j) => enabledTypes.has(j.type));
  if (due.length === 0) return [];

  const existing = new Set(
    (await db().job.findMany({ where: { key: { in: due.map((j) => j.key) } }, select: { key: true } })).map((j) => j.key),
  );
  const enqueued: PlannedJob[] = [];
  for (const job of due) {
    if (existing.has(job.key)) continue;
    // dedupeKey = key, so two workers ticking at once still enqueue only one.
    const created = await enqueue(db(), job.type, job.payload as never, { key: job.key, dedupeKey: job.key });
    if (created) enqueued.push(job);
  }
  return enqueued;
}
