"use client";
// The parts of the Today screen (design doc §7.1): the current stop as a door hanger, "Up next", and the
// collapsed "Done" group with outcome chips.
import { ChevronDown, Flame, Navigation } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Chip, OutcomeChip } from "@/components/ui/Chip";
import { HangerCard } from "@/components/ui/HangerCard";
import { clockTime } from "@/lib/rep/helpers";
import type { TodayStop } from "@/lib/services/repApp";

export function CurrentCard({
  stop,
  timeZone,
  dayOn,
  isNew,
  swinging,
  rising,
  ghost,
  onNavigate,
  onArrived,
  onOpen,
}: {
  stop: TodayStop;
  timeZone: string;
  dayOn: boolean;
  isNew?: boolean;
  swinging?: boolean;
  rising?: boolean;
  ghost?: boolean;
  onNavigate: () => void;
  onArrived: () => void;
  onOpen: () => void;
}) {
  const hot = stop.door.priority === "HOT";
  return (
    <HangerCard stopNumber={stop.routeOrder} hot={hot} swinging={swinging} rising={rising} ghost={ghost} data-testid={ghost ? "leaving-card" : "current-stop"}>
      <div className="flex flex-col gap-1">
        <h2 className="text-title-m">{stop.door.companyName}</h2>
        <p className="tnum text-body-l">{stop.door.address}</p>
        <p className="tnum text-caption text-ink-2">{stop.plannedArrival ? `Arrive about ${clockTime(stop.plannedArrival, timeZone)}` : "Not timed yet"}</p>
      </div>
      {(hot || isNew || stop.door.attempts > 0) && (
        <div className="flex flex-wrap gap-2">
          {hot && (
            <Chip tone="blue" icon={<Flame aria-hidden="true" size={16} />}>
              Hot
            </Chip>
          )}
          {isNew && <Chip tone="teal">Just added</Chip>}
          {stop.door.attempts > 0 && <Chip tone="slate">{stop.door.attempts === 1 ? "Visited once" : `Visited ${stop.door.attempts} times`}</Chip>}
        </div>
      )}
      {stop.door.qualificationNotes && (
        <button type="button" onClick={onOpen} className="text-left text-body-l text-ink-2" aria-label="Show details">
          <span className="line-clamp-2 whitespace-pre-line">{stop.door.qualificationNotes}</span>
        </button>
      )}
      {!ghost && (
        <div className="grid grid-cols-2 gap-2">
          <Button size="rep" variant="secondary" onClick={onNavigate}>
            <Navigation aria-hidden="true" size={22} />
            Navigate
          </Button>
          {stop.arrivedAt ? (
            <div role="status" className="grid h-14 place-items-center rounded-sm bg-green-bg text-label font-bold text-green-fg">
              Arrived {clockTime(stop.arrivedAt, timeZone)}
            </div>
          ) : (
            <Button size="rep" onClick={onArrived} disabled={!dayOn}>
              Arrived
            </Button>
          )}
        </div>
      )}
      {!ghost && (
        <button type="button" onClick={onOpen} className="min-h-12 self-start text-label text-link underline underline-offset-4">
          Details and skip
        </button>
      )}
      {!ghost && !dayOn && <p className="text-caption text-ink-2">Start your day to mark arrivals and log visits.</p>}
    </HangerCard>
  );
}

export function StopRow({ stop, timeZone, onOpen }: { stop: TodayStop; timeZone: string; onOpen: () => void }) {
  const done = stop.status !== "ACTIVE";
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex min-h-14 w-full items-center gap-3 border-b border-line py-2 text-left">
        <span className="tnum grid size-9 shrink-0 place-items-center rounded-full border-2 border-outline text-label font-bold">{stop.routeOrder ?? "–"}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 truncate text-title-s">
            {stop.door.priority === "HOT" && <Flame aria-label="Hot" size={16} className="shrink-0 text-hot-text" />}
            {stop.door.companyName}
          </span>
          <span className="tnum truncate text-caption text-ink-2">{stop.door.address}</span>
        </span>
        {done ? (
          stop.outcome ? <OutcomeChip outcome={stop.outcome} /> : <Chip tone="slate">Skipped</Chip>
        ) : (
          <span className="tnum text-body text-ink-2">{stop.plannedArrival ? clockTime(stop.plannedArrival, timeZone) : ""}</span>
        )}
      </button>
    </li>
  );
}

export function UpNext({ stops, timeZone, onOpen }: { stops: TodayStop[]; timeZone: string; onOpen: (s: TodayStop) => void }) {
  if (stops.length === 0) return null;
  return (
    <section aria-labelledby="up-next" className="flex flex-col">
      <h2 id="up-next" className="mb-1 text-title-s">
        Up next
      </h2>
      <ul>
        {stops.map((s) => (
          <StopRow key={s.assignmentId} stop={s} timeZone={timeZone} onOpen={() => onOpen(s)} />
        ))}
      </ul>
    </section>
  );
}

export function DoneGroup({ stops, timeZone, onOpen }: { stops: TodayStop[]; timeZone: string; onOpen: (s: TodayStop) => void }) {
  if (stops.length === 0) return null;
  return (
    <details className="group">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between text-title-s">
        <span>Done ({stops.length})</span>
        <ChevronDown aria-hidden="true" size={20} className="transition-transform group-open:rotate-180" />
      </summary>
      <ul>
        {stops.map((s) => (
          <StopRow key={s.assignmentId} stop={s} timeZone={timeZone} onOpen={() => onOpen(s)} />
        ))}
      </ul>
    </details>
  );
}
