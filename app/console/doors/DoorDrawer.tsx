"use client";
// Door detail drawer (PRD MGR-3): fields, assignments, visits and a timeline from the audit log.
import { DateTime } from "luxon";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AssignSheet, type RepChoice } from "@/components/console/AssignSheet";
import { Button } from "@/components/ui/Button";
import { OutcomeChip, StatusChip } from "@/components/ui/Chip";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import type { getDoorDetail } from "@/lib/services/doors";
import { REVIEW_REASON } from "@/lib/ui/status";
import { closeDoorAction, setPriorityAction } from "./actions";

type Detail = Awaited<ReturnType<typeof getDoorDetail>>;
// Dates arrive as ISO strings after crossing the server/client boundary.
type Serialized<T> = T extends Date ? string : T extends (infer U)[] ? Serialized<U>[] : T extends object ? { [K in keyof T]: Serialized<T[K]> } : T;

const ACTION_LABELS: Record<string, string> = {
  "door.created": "Created from intake",
  "door.merged": "Another posting merged in",
  "door.geocoded": "Address resolved",
  "door.needs_review": "Sent to review",
  "review.resolved": "Review resolved",
  "door.updated": "Edited",
  "door.closed": "Closed",
  "crm_id.updated": "CRM ID stored",
};

const when = (iso: string | null) => (iso ? DateTime.fromISO(iso).toLocaleString(DateTime.DATETIME_MED) : "—");

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-ink-2">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** Statuses a manager can hand to a rep (the door has a location and is still open). */
const ASSIGNABLE = ["GEOCODED", "ASSIGNED", "SCHEDULED", "VISITED", "UNASSIGNABLE"];

export function DoorDrawer({ detail, closeHref, editable, reps }: { detail: Serialized<Detail>; closeHref: string; editable: boolean; reps: RepChoice[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const d = detail.door;
  const current = d.currentAssignment;
  const address = [d.address.street, d.address.city, [d.address.state, d.address.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const open = d.status !== "CLOSED";

  return (
    <Sheet open onClose={() => router.push(closeHref, { scroll: false })} title={d.company.name}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={d.status} />
          {d.reviewReason && <span className="text-body text-ink-2">{REVIEW_REASON[d.reviewReason].label}</span>}
        </div>

        <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-body">
          <Row label="Address">{address || "Not resolved yet"}</Row>
          <Row label="Address source">{d.addressSource ? d.addressSource.replaceAll("_", " ").toLowerCase() : "—"}</Row>
          <Row label="Job location">{d.jobLocation ?? "—"}</Row>
          <Row label="Priority">{d.priority === "HOT" ? "Hot" : "Normal"}</Row>
          <Row label="Visit window">{d.preferredVisitWindow ? d.preferredVisitWindow.toLowerCase() : "Any time"}</Row>
          <Row label="Attempts">
            <span className="tnum">{d.attempts}</span>
          </Row>
          <Row label="Prospect ID">
            <span className="tnum">{d.externalProspectId}</span>
          </Row>
          <Row label="Source">{detail.source.toLowerCase()}</Row>
          <Row label="Contact">{[detail.contact.name, detail.contact.phone, detail.contact.email].filter(Boolean).join(" · ") || "—"}</Row>
          <Row label="CRM">{d.crmId ?? "Not synced yet"}</Row>
        </dl>

        {d.qualificationNotes && (
          <section className="flex flex-col gap-1">
            <h3 className="text-label">Qualification notes</h3>
            <p className="whitespace-pre-line text-body">{d.qualificationNotes}</p>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="text-label">Assignments</h3>
          {detail.assignments.length === 0 ? (
            <p className="text-body text-ink-2">Not assigned yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-body">
              {detail.assignments.map((a) => (
                <li key={a.id}>
                  <span className="tnum">{a.scheduledFor}</span> · {a.repName} · {a.status.toLowerCase().replaceAll("_", " ")}
                  {a.reason ? ` (${a.reason})` : ""}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-label">Visits</h3>
          {detail.visits.length === 0 ? (
            <p className="text-body text-ink-2">No visits yet.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-body">
              {detail.visits.map((v) => (
                <li key={v.id} className="flex flex-col gap-1">
                  <span className="flex items-center gap-2">
                    <OutcomeChip outcome={v.outcome} /> <span className="tnum text-ink-2">{when(v.recordedAt)}</span>
                  </span>
                  {v.notes && <span>{v.notes}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-label">Timeline</h3>
          <ol className="flex flex-col gap-2 border-l-2 border-line pl-4 text-body">
            {detail.timeline.map((t) => (
              <li key={t.id}>
                <span className="font-semibold">{ACTION_LABELS[t.action] ?? t.action}</span> <span className="text-ink-2">by {t.actor}</span>
                <br />
                <span className="tnum text-caption text-ink-3">{when(t.at)}</span>
              </li>
            ))}
          </ol>
        </section>

        {error && (
          <p role="alert" className="rounded-sm bg-red-bg px-4 py-3 text-body text-red-fg">
            {error}
          </p>
        )}

        {editable && open && (
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            {ASSIGNABLE.includes(d.status) && (
              <Button disabled={pending} onClick={() => setAssigning(true)}>
                {current ? "Reassign" : "Assign"}
              </Button>
            )}
            {current && (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  const reason = window.prompt(`Take ${d.company.name} off ${current.repName}'s route? Why?`);
                  if (!reason?.trim()) return;
                  start(async () => {
                    const res = await fetch(`/api/v1/doors/${d.id}/unassign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) return setError(data.error?.message ?? "That did not work.");
                    toast.show("Door unassigned");
                    router.refresh();
                  });
                }}
              >
                Unassign
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await setPriorityAction(d.id, d.priority === "HOT" ? "NORMAL" : "HOT");
                  if (r.error) setError(r.error);
                  else {
                    toast.show(d.priority === "HOT" ? "Marked normal" : "Marked hot");
                    router.refresh();
                  }
                })
              }
            >
              {d.priority === "HOT" ? "Mark as normal" : "Mark as hot"}
            </Button>
            <Button
              variant="danger"
              disabled={pending}
              onClick={() => {
                const note = window.prompt(`Close ${d.company.name}? Add a note (optional):`);
                if (note === null) return;
                start(async () => {
                  const r = await closeDoorAction(d.id, note);
                  if (r.error) setError(r.error);
                  else {
                    toast.show("Door closed");
                    router.refresh();
                  }
                });
              }}
            >
              Close door
            </Button>
          </div>
        )}
      </div>
      <AssignSheet open={assigning} onClose={() => setAssigning(false)} doorId={d.id} doorName={d.company.name} reps={reps} defaultRepId={current?.repId} defaultDate={current?.scheduledFor} />
    </Sheet>
  );
}
