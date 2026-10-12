"use client";
// A stop's detail (PRD REP-10, REP-3): address, notes, the last visit, and the same actions as the card, so a
// rep can work the route out of order.
import { Flame, Navigation, SkipForward } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Chip, OutcomeChip } from "@/components/ui/Chip";
import { Sheet } from "@/components/ui/Sheet";
import type { Outcome } from "@/lib/domain/enums";
import { clockTime } from "@/lib/rep/helpers";
import type { TodayStop } from "@/lib/services/repApp";

export function StopSheet({
  stop,
  timeZone,
  dayOn,
  onClose,
  onNavigate,
  onArrived,
  onLog,
  onSkip,
  online,
}: {
  stop: TodayStop | null;
  timeZone: string;
  dayOn: boolean;
  onClose: () => void;
  onNavigate: (s: TodayStop) => void;
  onArrived: (s: TodayStop) => void;
  onLog: (s: TodayStop) => void;
  onSkip: (s: TodayStop) => void;
  online: boolean;
}) {
  const open = stop !== null;
  const active = stop?.status === "ACTIVE";

  // The door's full history, when there is a connection (the last visit above works offline).
  type History = { visits: { recordedAt: string; outcome: Outcome; notes: string; repName: string; you: boolean }[] };
  const [history, setHistory] = useState<{ doorId: string; data: History } | null>(null);
  const doorId = stop?.door.id;
  useEffect(() => {
    if (!doorId || !online) return;
    let cancelled = false;
    void fetch(`/api/v1/rep/doors/${doorId}/history`, { credentials: "same-origin" })
      .then((r) => (r.ok ? (r.json() as Promise<History>) : null))
      .then((data) => {
        if (data && !cancelled) setHistory({ doorId, data });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doorId, online]);
  const visits = history && history.doorId === doorId ? history.data.visits : null;
  return (
    <Sheet open={open} onClose={onClose} side="bottom" title={stop?.door.companyName ?? "Stop"}>
      {stop && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {stop.door.priority === "HOT" && (
              <Chip tone="blue" icon={<Flame aria-hidden="true" size={16} />}>
                Hot
              </Chip>
            )}
            {stop.outcome && <OutcomeChip outcome={stop.outcome} />}
            {stop.status === "SKIPPED" && <Chip tone="slate">Skipped</Chip>}
          </div>
          <p className="tnum text-body-l">{stop.door.address}</p>
          <p className="tnum text-caption text-ink-2">
            {stop.plannedArrival ? `Planned about ${clockTime(stop.plannedArrival, timeZone)}` : "Not timed yet"}
            {stop.arrivedAt ? ` · Arrived ${clockTime(stop.arrivedAt, timeZone)}` : ""}
          </p>
          {stop.door.contactName && <p className="text-body-l">Ask for {stop.door.contactName}</p>}
          {stop.door.qualificationNotes && <p className="whitespace-pre-line text-body-l text-ink-2">{stop.door.qualificationNotes}</p>}
          {visits && visits.length > 1 && (
            <section className="flex flex-col gap-2 border-t border-line pt-3" aria-label="Visit history">
              <h3 className="text-label">History</h3>
              <ul className="flex flex-col gap-2">
                {visits.map((v) => (
                  <li key={v.recordedAt + v.repName} className="flex flex-col gap-0.5 text-body">
                    <span className="flex items-center gap-2">
                      <OutcomeChip outcome={v.outcome} />
                      <span className="tnum text-ink-2">{clockTime(v.recordedAt, timeZone)}</span>
                      <span className="text-caption text-ink-3">{v.you ? "You" : v.repName}</span>
                    </span>
                    {v.notes && <span className="text-ink-2">{v.notes}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(!visits || visits.length <= 1) && stop.door.lastVisit && (
            <section className="flex flex-col gap-1 border-t border-line pt-3">
              <h3 className="text-label">Last visit</h3>
              <p className="flex items-center gap-2 text-body">
                <OutcomeChip outcome={stop.door.lastVisit.outcome} />
                <span className="tnum text-ink-2">{clockTime(stop.door.lastVisit.recordedAt, timeZone)}</span>
              </p>
              {stop.door.lastVisit.notes && <p className="text-body text-ink-2">{stop.door.lastVisit.notes}</p>}
            </section>
          )}
          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <Button size="rep" variant="secondary" block onClick={() => onNavigate(stop)}>
              <Navigation aria-hidden="true" size={22} />
              Navigate
            </Button>
            {active && !stop.arrivedAt && (
              <Button size="rep" block disabled={!dayOn} onClick={() => onArrived(stop)}>
                Arrived
              </Button>
            )}
            {active && (
              <Button size="rep" variant={stop.arrivedAt ? "primary" : "secondary"} block disabled={!dayOn} onClick={() => onLog(stop)}>
                Log visit
              </Button>
            )}
            {active && !dayOn && <p className="text-caption text-ink-2">Start your day to log visits.</p>}
            {active && (
              <Button size="rep" variant="quiet" block onClick={() => onSkip(stop)}>
                <SkipForward aria-hidden="true" size={22} />
                Skip this stop
              </Button>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}
