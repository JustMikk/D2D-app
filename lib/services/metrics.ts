// Metrics (PRD MGR-8) and pilot health (PRD §3 success metrics).
import { z } from "zod";
import { validationFailed } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { addDays, localDateOf } from "@/lib/domain/time";
import { CONTACT_OUTCOMES } from "@/lib/events";
import { getSetting } from "@/lib/settings";

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const MAX_RANGE_DAYS = 92;

export const MetricsQuery = z.object({
  from: LocalDate,
  to: LocalDate,
  repId: z.string().optional(),
  format: z.enum(["json", "csv"]).default("json"),
});
export type MetricsQuery = z.infer<typeof MetricsQuery>;

export type DayMetrics = {
  date: string;
  repId: string;
  repName: string;
  visited: number;
  contacts: number;
  appointments: number;
  sales: number;
  /** Contacts as a share of visits (any outcome other than not home or bad address), or null with no visits. */
  contactRate: number | null;
  driveMinutes: number;
  driveMinutesPerVisit: number | null;
};

export type Totals = Omit<DayMetrics, "date" | "repId" | "repName">;

function rate(num: number, den: number): number | null {
  return den === 0 ? null : Math.round((num / den) * 1000) / 1000;
}

function totalsOf(rows: DayMetrics[]): Totals {
  const sum = (k: "visited" | "contacts" | "appointments" | "sales" | "driveMinutes") => rows.reduce((n, r) => n + r[k], 0);
  const visited = sum("visited");
  const contacts = sum("contacts");
  const driveMinutes = sum("driveMinutes");
  return { visited, contacts, appointments: sum("appointments"), sales: sum("sales"), contactRate: rate(contacts, visited), driveMinutes, driveMinutesPerVisit: visited ? Math.round((driveMinutes / visited) * 10) / 10 : null };
}

/**
 * Visits count on the local day (in the rep's time zone) they were recorded. Drive minutes come from the
 * latest route plan for that rep and date, so they only count days that were planned.
 */
export async function getMetrics(input: unknown) {
  const q = MetricsQuery.parse(input);
  if (q.to < q.from) throw validationFailed([{ path: "to", message: "The end date is before the start date" }]);
  const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 + 1;
  if (days > MAX_RANGE_DAYS) throw validationFailed([{ path: "to", message: `Pick at most ${MAX_RANGE_DAYS} days` }]);

  const reps = await db().rep.findMany({ where: q.repId ? { id: q.repId } : {}, include: { user: { select: { name: true } } } });
  const byDay = new Map<string, DayMetrics>();
  const key = (repId: string, date: string) => `${repId}|${date}`;
  const row = (repId: string, repName: string, date: string): DayMetrics => {
    const k = key(repId, date);
    if (!byDay.has(k)) byDay.set(k, { date, repId, repName, visited: 0, contacts: 0, appointments: 0, sales: 0, contactRate: null, driveMinutes: 0, driveMinutesPerVisit: null });
    return byDay.get(k)!;
  };

  for (const rep of reps) {
    // Widen by a day each way, then keep only visits whose local date is inside the range.
    const visits = await db().visit.findMany({
      where: { repId: rep.id, recordedAt: { gte: new Date(`${addDays(q.from, -1)}T00:00:00Z`), lt: new Date(`${addDays(q.to, 2)}T00:00:00Z`) } },
      select: { outcome: true, recordedAt: true },
    });
    for (const v of visits) {
      const date = localDateOf(v.recordedAt, rep.timeZone);
      if (date < q.from || date > q.to) continue;
      const r = row(rep.id, rep.user.name, date);
      r.visited++;
      if (CONTACT_OUTCOMES.includes(v.outcome as never)) r.contacts++;
      if (v.outcome === "APPOINTMENT_SET") r.appointments++;
      if (v.outcome === "SOLD") r.sales++;
    }
    const plans = await db().routePlan.findMany({ where: { repId: rep.id, date: { gte: q.from, lte: q.to } }, orderBy: { createdAt: "asc" }, select: { date: true, totalDriveMinutes: true } });
    const latest = new Map(plans.map((p) => [p.date, p.totalDriveMinutes ?? 0])); // later plans overwrite earlier ones
    for (const [date, minutes] of latest) if (minutes > 0 || byDay.has(key(rep.id, date))) row(rep.id, rep.user.name, date).driveMinutes = minutes;
  }

  const rows = [...byDay.values()]
    .map((r) => ({ ...r, contactRate: rate(r.contacts, r.visited), driveMinutesPerVisit: r.visited ? Math.round((r.driveMinutes / r.visited) * 10) / 10 : null }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.repName.localeCompare(b.repName));

  const perRep = [...new Set(rows.map((r) => r.repId))].map((repId) => {
    const mine = rows.filter((r) => r.repId === repId);
    return { repId, repName: mine[0]!.repName, days: mine.filter((r) => r.visited > 0).length, ...totalsOf(mine) };
  }).sort((a, b) => a.repName.localeCompare(b.repName));

  return { from: q.from, to: q.to, rows, perRep, totals: totalsOf(rows) };
}

const csvCell = (v: string | number | null) => {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** One line per rep per day, then each rep's total, in a form a spreadsheet opens directly. */
export function metricsCsv(m: Awaited<ReturnType<typeof getMetrics>>): string {
  const head = ["Date", "Rep", "Visited", "Contacts", "Appointments", "Sales", "Contact rate", "Drive minutes", "Drive minutes per visit"];
  const line = (a: (string | number | null)[]) => a.map(csvCell).join(",");
  const out = [line(head)];
  for (const r of m.rows) out.push(line([r.date, r.repName, r.visited, r.contacts, r.appointments, r.sales, r.contactRate, r.driveMinutes, r.driveMinutesPerVisit]));
  for (const r of m.perRep) out.push(line([`Total ${m.from} to ${m.to}`, r.repName, r.visited, r.contacts, r.appointments, r.sales, r.contactRate, r.driveMinutes, r.driveMinutesPerVisit]));
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Pilot health: the PRD §3 success metrics, computed from what actually happened.
// ---------------------------------------------------------------------------

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export type HealthMetric = { id: string; label: string; target: string; value: number | null; display: string; sample: number; pass: boolean | null };

export async function getPilotHealth(input: { from: string; to: string }): Promise<HealthMetric[]> {
  const q = z.object({ from: LocalDate, to: LocalDate }).parse(input);
  const tz = await getSetting("schedule.digestTimeZone");
  const start = new Date(`${addDays(q.from, -1)}T00:00:00Z`);
  const end = new Date(`${addDays(q.to, 2)}T00:00:00Z`);
  const inRange = (d: Date) => {
    const local = localDateOf(d, tz);
    return local >= q.from && local <= q.to;
  };

  // G1: intake to first assignment, p90.
  const doors = (await db().door.findMany({ where: { createdAt: { gte: start, lt: end } }, select: { id: true, createdAt: true, assignments: { orderBy: { createdAt: "asc" }, take: 1, select: { createdAt: true } } } })).filter((d) => inRange(d.createdAt));
  const assignMinutes = doors.filter((d) => d.assignments[0]).map((d) => (d.assignments[0]!.createdAt.getTime() - d.createdAt.getTime()) / 60_000);
  const p90Assign = percentile(assignMinutes, 90);

  // Doors that never needed a manager's address decision.
  const reviewed = new Set((await db().auditLog.findMany({ where: { entityType: "DOOR", action: "door.needs_review", entityId: { in: doors.map((d) => d.id) } }, select: { entityId: true } })).map((a) => a.entityId));
  const noReview = doors.length ? (doors.length - doors.filter((d) => reviewed.has(d.id)).length) / doors.length : null;

  // G2: time to log a visit, median; G4: visits synced within a minute.
  const visits = (await db().visit.findMany({ where: { recordedAt: { gte: start, lt: end } }, select: { recordedAt: true, receivedAt: true, formDurationS: true } })).filter((v) => inRange(v.recordedAt));
  const durations = visits.map((v) => v.formDurationS).filter((n): n is number => n !== null);
  const medianLog = percentile(durations, 50);
  const synced = visits.length ? visits.filter((v) => v.receivedAt.getTime() - v.recordedAt.getTime() <= 60_000).length / visits.length : null;

  // G3: outcome alerts to the CEO, p90, from the outbox.
  const hot = (await db().outboxEvent.findMany({ where: { type: "visit.hot", status: "SENT", createdAt: { gte: start, lt: end } }, select: { createdAt: true, sentAt: true } })).filter((e) => e.sentAt && inRange(e.createdAt));
  const p90Alert = percentile(hot.map((e) => (e.sentAt!.getTime() - e.createdAt.getTime()) / 1000), 90);

  const pct = (v: number | null) => (v === null ? "No data yet" : `${Math.round(v * 1000) / 10}%`);
  const metrics: HealthMetric[] = [
    { id: "intake-to-assignment", label: "Intake to assignment, p90", target: "5 minutes or less", value: p90Assign, display: p90Assign === null ? "No data yet" : `${Math.round(p90Assign * 10) / 10} min`, sample: assignMinutes.length, pass: p90Assign === null ? null : p90Assign <= 5 },
    { id: "no-review", label: "Doors resolved without manual review", target: "85% or more", value: noReview, display: pct(noReview), sample: doors.length, pass: noReview === null ? null : noReview >= 0.85 },
    { id: "log-time", label: "Time to log a visit, median", target: "30 seconds or less", value: medianLog, display: medianLog === null ? "No data yet" : `${medianLog} s`, sample: durations.length, pass: medianLog === null ? null : medianLog <= 30 },
    { id: "synced", label: "Visits synced within 60 seconds", target: "99% or more (offline visits count against it, by design)", value: synced, display: pct(synced), sample: visits.length, pass: synced === null ? null : synced >= 0.99 },
    { id: "alert", label: "Outcome alert to the CEO, p90", target: "60 seconds or less", value: p90Alert, display: p90Alert === null ? "No data yet" : `${Math.round(p90Alert)} s`, sample: hot.length, pass: p90Alert === null ? null : p90Alert <= 60 },
  ];
  return metrics;
}
