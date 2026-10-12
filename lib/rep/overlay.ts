// What the rep sees: the last data from the server with the rep's own queued actions applied on top, so
// "Start day", "Arrived" and a saved visit show at once, offline or not, and never flicker back when a
// refetch lands before the queue has synced (PRD REP-3, REP-7).
import type { TodayResponse, TodayStop } from "@/lib/services/repApp";
import type { OutboxItem } from "./outbox";

export type Pending = {
  /** Visits not yet acknowledged. */
  visits: number;
  /** Everything else the rep did that has not synced (shift, arrivals). Pings and photos are not counted. */
  changes: number;
  failed: number;
  failedItems: OutboxItem[];
};

export function summarize(items: OutboxItem[]): Pending {
  const failedItems = items.filter((i) => i.status === "failed");
  const waiting = items.filter((i) => i.status === "pending");
  return {
    visits: items.filter((i) => i.kind === "visit").length,
    changes: waiting.filter((i) => i.kind === "shift.start" || i.kind === "shift.end" || i.kind === "arrive" || i.kind === "skip").length,
    failed: failedItems.filter((i) => i.kind !== "ping" && i.kind !== "event").length,
    failedItems,
  };
}

/** Apply queued actions, in order, to a Today response. Pure; the input is not changed. */
export function applyOutbox(today: TodayResponse | null, items: OutboxItem[]): TodayResponse | null {
  if (!today) return null;
  let shift = today.shift;
  const stops = new Map<string, TodayStop>(today.stops.map((s) => [s.assignmentId, s]));

  for (const item of items) {
    if (item.kind === "shift.start") {
      if (!shift || shift.endedAt) shift = { id: `local-${item.payload.clientId}`, startedAt: item.payload.recordedAt, endedAt: null };
    } else if (item.kind === "shift.end") {
      if (shift && !shift.endedAt) shift = { ...shift, endedAt: item.payload.recordedAt };
    } else if (item.kind === "arrive") {
      const s = stops.get(item.payload.assignmentId);
      if (s && !s.arrivedAt) stops.set(s.assignmentId, { ...s, arrivedAt: item.payload.recordedAt });
    } else if (item.kind === "skip") {
      const s = stops.get(item.payload.assignmentId);
      if (s && s.status === "ACTIVE") stops.set(s.assignmentId, { ...s, status: "SKIPPED" });
    } else if (item.kind === "visit") {
      const s = stops.get(item.payload.assignmentId);
      if (s) stops.set(s.assignmentId, { ...s, status: "COMPLETED", outcome: item.payload.outcome });
    }
  }
  return { ...today, shift, stops: [...stops.values()] };
}

/** The shift is on when it has started and not ended. */
export function onShift(today: TodayResponse | null): boolean {
  return Boolean(today?.shift && !today.shift.endedAt);
}

export type Sections = { current: TodayStop | null; upNext: TodayStop[]; done: TodayStop[] };

/** Current stop first, then the rest of the route in order; finished and skipped stops go to Done. */
export function sections(today: TodayResponse | null): Sections {
  const stops = today?.stops ?? [];
  const open = stops.filter((s) => s.status === "ACTIVE").sort((a, b) => (a.routeOrder ?? Infinity) - (b.routeOrder ?? Infinity));
  const done = stops.filter((s) => s.status !== "ACTIVE").sort((a, b) => (a.routeOrder ?? Infinity) - (b.routeOrder ?? Infinity));
  return { current: open[0] ?? null, upNext: open.slice(1), done };
}
