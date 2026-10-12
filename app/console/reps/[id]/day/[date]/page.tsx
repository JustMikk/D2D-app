import { DateTime } from "luxon";
import { ChevronLeft, ChevronRight, Flame, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Chip, OutcomeChip, StatusChip } from "@/components/ui/Chip";
import { ApiError } from "@/lib/api/errors";
import { CONSOLE_ROLES, canManage } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import type { DoorStatus, Outcome } from "@/lib/domain/enums";
import { addDays } from "@/lib/domain/time";
import { getRepDay, repChoices } from "@/lib/services/reps";
import { DayActions, MoveButtons, StopActions } from "./DayActions";
import { notFound } from "next/navigation";

// Rep day board (PRD MGR-5): a rep's route for a date, with reassign, unassign and re-plan.
export default async function DayBoardPage({ params }: { params: Promise<{ id: string; date: string }> }) {
  const user = await requireUser(CONSOLE_ROLES);
  const { id, date } = await params;
  const [day, reps] = await Promise.all([
    getRepDay(user.id, id, date).catch((e: unknown) => {
      if (e instanceof ApiError || (e instanceof Error && e.name === "ZodError")) return null;
      throw e;
    }),
    repChoices(),
  ]);
  if (!day) notFound();

  const tz = day.rep.timeZone;
  const time = (d: Date | string | null) => (d ? DateTime.fromJSDate(new Date(d), { zone: tz }).toFormat("h:mm a") : "—");
  const manage = canManage(user.role);
  const nav = (d: string) => `/console/reps/${id}/day/${d}`;
  const label = DateTime.fromISO(date).toLocaleString({ weekday: "long", month: "long", day: "numeric" });
  const open = day.stops.filter((s) => s.status === "ACTIVE").length;
  const done = day.stops.filter((s) => s.status === "COMPLETED").length;
  const openIds = day.stops.filter((s) => s.status === "ACTIVE").map((s) => s.assignmentId);

  return (
    <div className="flex max-w-[1200px] flex-col gap-6">
      <Link href="/console/reps" className="inline-flex w-fit items-center gap-1 text-label text-link underline-offset-4 hover:underline">
        <ChevronLeft aria-hidden="true" size={16} />
        All reps
      </Link>

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-title-l">{day.rep.name}</h1>
          <p className="text-body text-ink-2">
            {label} · {tz}
            {day.rep.isToday ? " · today" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={nav(addDays(date, -1))} aria-label="Previous day" className="grid size-10 place-items-center rounded-sm border border-line-strong bg-surface">
            <ChevronLeft aria-hidden="true" size={18} />
          </Link>
          <Link href={nav(addDays(date, 1))} aria-label="Next day" className="grid size-10 place-items-center rounded-sm border border-line-strong bg-surface">
            <ChevronRight aria-hidden="true" size={18} />
          </Link>
          {manage && <DayActions repId={id} date={date} canReplan={!day.rep.unavailable && date >= (reps.find((r) => r.id === id)?.today ?? date)} />}
        </div>
      </header>

      <section className="flex flex-wrap gap-3" aria-label="Summary">
        <Chip tone="slate">
          {day.stops.length} {day.stops.length === 1 ? "stop" : "stops"} · {done} done · {open} open
        </Chip>
        {day.route?.totalDriveMinutes != null && <Chip tone="slate">{day.route.totalDriveMinutes} min driving</Chip>}
        {day.route?.plannedFinish && <Chip tone="slate">Finish about {time(day.route.plannedFinish)}</Chip>}
        {day.route && day.route.late > 0 && (
          <Chip tone="amber" icon={<TriangleAlert aria-hidden="true" size={16} />}>
            {day.route.late} planned after 8 pm
          </Chip>
        )}
        {day.overCapacity && (
          <Chip tone="amber" icon={<TriangleAlert aria-hidden="true" size={16} />}>
            Over capacity ({day.rep.dailyCapacity} a day)
          </Chip>
        )}
        {day.rep.unavailable && <Chip tone="red">Marked off this day</Chip>}
        {day.shift && <Chip tone="green">Shift {time(day.shift.startedAt)}{day.shift.endedAt ? ` to ${time(day.shift.endedAt)}` : ", running"}</Chip>}
        {day.route?.fallback && <Chip tone="amber">Google failed; built-in planner used</Chip>}
        {!day.route && day.stops.length > 0 && <Chip tone="slate">Not planned yet</Chip>}
      </section>

      {day.stops.length === 0 ? (
        <p className="text-body text-ink-2">No stops on this day.</p>
      ) : (
        <table className="w-full border-collapse text-body">
          <thead>
            <tr className="border-b border-line text-left text-label text-ink-2">
              <th className="py-2 pr-4 font-semibold">#</th>
              <th className="py-2 pr-4 font-semibold">Company</th>
              <th className="py-2 pr-4 font-semibold">Address</th>
              <th className="py-2 pr-4 font-semibold">Planned arrival</th>
              <th className="py-2 pr-4 font-semibold">Status</th>
              <th className="py-2 pr-4 font-semibold">Assigned by</th>
              {manage && (
                <th className="py-2 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {day.stops.map((s) => (
              <tr key={s.assignmentId} className="border-b border-line">
                <td className="tnum py-2.5 pr-4 font-semibold">{s.routeOrder ?? "—"}</td>
                <td className="py-2.5 pr-4">
                  <Link href={`/console/doors?door=${s.doorId}`} className="inline-flex items-center gap-1.5 font-semibold hover:underline">
                    {s.priority === "HOT" && <Flame aria-label="Hot" size={16} className="text-hot-text" />}
                    {s.name}
                  </Link>
                </td>
                <td className="py-2.5 pr-4 text-ink-2">{s.address || "—"}</td>
                <td className="tnum py-2.5 pr-4">{time(s.plannedArrival)}</td>
                <td className="py-2.5 pr-4">
                  {s.status === "COMPLETED" && s.outcome ? <OutcomeChip outcome={s.outcome as Outcome} /> : s.status === "SKIPPED" ? <Chip tone="slate">Skipped</Chip> : <StatusChip status={s.doorStatus as DoorStatus} />}
                </td>
                <td className="py-2.5 pr-4 text-ink-2">{s.assignedBy === "MANAGER" ? "Manager" : "Engine"}</td>
                {manage && (
                  <td className="py-2.5 text-right">
                    {s.status === "ACTIVE" && (
                      <div className="flex items-center justify-end gap-1">
                        {openIds.length > 1 && date >= (reps.find((r) => r.id === id)?.today ?? date) && <MoveButtons repId={id} date={date} name={s.name} openIds={openIds} index={openIds.indexOf(s.assignmentId)} />}
                        <StopActions doorId={s.doorId} doorName={s.name} date={date} repId={id} reps={reps} />
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {day.pings.length > 0 && (
        <p className="text-body text-ink-2">
          {day.pings.length} location {day.pings.length === 1 ? "point" : "points"} recorded. Last seen {time(day.pings.at(-1)!.at)}. The map arrives with the live map.
        </p>
      )}
    </div>
  );
}
