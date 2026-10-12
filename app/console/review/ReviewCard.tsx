"use client";
// One door waiting for a decision: what was tried (ADR-3) next to the actions (ADR-4).
import { DateTime } from "luxon";
import { Flame } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { onSubmitWith } from "@/components/ui/form";
import { Chip } from "@/components/ui/Chip";
import { Field, Input } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import type { ReviewEvidence } from "@/lib/domain/addressResolution";
import type { ReviewReason } from "@/lib/domain/enums";
import { REVIEW_REASON } from "@/lib/ui/status";
import { resolveAction } from "./actions";
import type { ReviewResolve } from "@/lib/services/review";

export type ReviewItem = {
  id: string;
  name: string;
  companyName: string;
  companyWebsite: string | null;
  externalProspectId: string;
  priority: string;
  jobLocation: string | null;
  address: { street: string | null; city: string | null; state: string | null; zip: string | null };
  qualificationNotes: string;
  reviewReason: ReviewReason;
  evidence: ReviewEvidence;
  since: string;
};

function line(a: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null } | undefined) {
  if (!a) return null;
  const text = [a.street, a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return text || null;
}

export function ReviewCard({ item, editable }: { item: ReviewItem; editable: boolean }) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const toast = useToast();
  const ev = item.evidence;
  const companyLine = line(ev.companyAddress) ?? line(item.address);
  const canUseCompany = Boolean(ev.companyAddress && /^\d/.test(ev.companyAddress.street ?? ""));

  function run(action: ReviewResolve, done: string) {
    setError(null);
    setFields({});
    start(async () => {
      const result = await resolveAction(item.id, action);
      if (result.ok) toast.show(done);
      else {
        setError(result.error);
        setFields(result.fields ?? {});
      }
    });
  }

  function submitEdit(form: FormData) {
    run(
      {
        action: "EDIT_ADDRESS",
        address: {
          street: String(form.get("street") ?? ""),
          city: String(form.get("city") ?? ""),
          state: String(form.get("state") ?? ""),
          zip: String(form.get("zip") ?? ""),
        },
      },
      "Address saved",
    );
  }

  return (
    <article className="flex flex-col gap-4 rounded-md border border-line bg-surface p-5" aria-label={item.companyName}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-title-s">{item.companyName}</h3>
          <p className="text-body text-ink-2">
            {item.jobLocation ? `Job in ${item.jobLocation}` : "No job location"} · <span className="tnum">{item.externalProspectId}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {item.priority === "HOT" && (
            <Chip tone="blue" icon={<Flame aria-hidden="true" size={16} />}>
              Hot
            </Chip>
          )}
          <Chip tone="amber">{REVIEW_REASON[item.reviewReason].label}</Chip>
          <span className="text-caption text-ink-3">{DateTime.fromISO(item.since).toRelative()}</span>
        </div>
      </header>

      <dl className="grid grid-cols-[180px_1fr] gap-x-4 gap-y-2 text-body">
        <dt className="text-ink-2">Company address</dt>
        <dd>{companyLine ?? "None given"}</dd>
        {ev.jobCity && (
          <>
            <dt className="text-ink-2">Job city</dt>
            <dd>{[ev.jobCity.city, ev.jobCity.state].filter(Boolean).join(", ")}</dd>
          </>
        )}
        {ev.distanceMiles !== undefined && (
          <>
            <dt className="text-ink-2">Distance</dt>
            <dd className="tnum">{ev.distanceMiles} mi between them</dd>
          </>
        )}
        {ev.geocode && (
          <>
            <dt className="text-ink-2">Geocode</dt>
            <dd>
              {ev.geocode.query}: {ev.geocode.quality?.toLowerCase() ?? ev.geocode.status.toLowerCase()}
              {ev.geocode.partialMatch ? ", partial match" : ""}
            </dd>
          </>
        )}
        {ev.coverage && (
          <>
            <dt className="text-ink-2">Nearest rep</dt>
            <dd className="tnum">
              {ev.coverage.nearestRepName}, {ev.coverage.driveMinutes} min drive (limit {ev.coverage.maxDriveMinutes})
            </dd>
          </>
        )}
        {item.qualificationNotes && (
          <>
            <dt className="text-ink-2">Notes</dt>
            <dd className="line-clamp-2">{item.qualificationNotes}</dd>
          </>
        )}
      </dl>

      {ev.placesCandidates && ev.placesCandidates.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-label">Places tried</h4>
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="border-b border-line text-left text-label text-ink-2">
                <th className="py-2 pr-4 font-semibold">Name</th>
                <th className="py-2 pr-4 font-semibold">Address</th>
                <th className="py-2 pr-4 font-semibold">Name match</th>
                <th className="py-2 pr-4 font-semibold">Why not used</th>
                {editable && <th className="py-2 font-semibold"><span className="sr-only">Action</span></th>}
              </tr>
            </thead>
            <tbody>
              {ev.placesCandidates.map((c, i) => (
                <tr key={c.placeId || i} className="border-b border-line">
                  <td className="py-2 pr-4">{c.name}</td>
                  <td className="py-2 pr-4">{line(c) ?? "—"}</td>
                  <td className="tnum py-2 pr-4">{Math.round(c.similarity * 100)}%</td>
                  <td className="py-2 pr-4 text-ink-2">{c.rejectedBecause ?? "—"}</td>
                  {editable && (
                    <td className="py-2 text-right">
                      <Button variant="secondary" disabled={pending || !c.street} onClick={() => run({ action: "ACCEPT_PLACES_CANDIDATE", candidateIndex: i }, "Place accepted")}>
                        Use this place
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-sm bg-red-bg px-4 py-3 text-body text-red-fg">
          {error}
        </p>
      )}

      {editable && editing && (
        <form onSubmit={onSubmitWith(submitEdit)} className="grid grid-cols-[2fr_1fr_80px_110px_auto] items-end gap-3">
          <Field label="Street" error={fields.street}>
            {(p) => <Input {...p} name="street" required defaultValue={item.address.street ?? ""} placeholder="1500 Main St" />}
          </Field>
          <Field label="City" error={fields.city}>
            {(p) => <Input {...p} name="city" required defaultValue={item.address.city ?? ""} />}
          </Field>
          <Field label="State" error={fields.state}>
            {(p) => <Input {...p} name="state" required defaultValue={item.address.state ?? ""} maxLength={20} />}
          </Field>
          <Field label="ZIP" error={fields.zip}>
            {(p) => <Input {...p} name="zip" required defaultValue={item.address.zip ?? ""} inputMode="numeric" />}
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              Save address
            </Button>
            <Button variant="quiet" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {editable && !editing && (
        <div className="flex flex-wrap gap-2">
          {canUseCompany && item.reviewReason !== "COVERAGE_GAP" && (
            <Button disabled={pending} onClick={() => run({ action: "USE_COMPANY_ADDRESS" }, "Company address used")}>
              Use company address
            </Button>
          )}
          {item.reviewReason === "COVERAGE_GAP" && (
            <Button disabled={pending} onClick={() => run({ action: "CLEAR_COVERAGE_GAP" }, "Sent for assignment")}>
              Assign anyway
            </Button>
          )}
          <Button variant="secondary" disabled={pending} onClick={() => setEditing(true)}>
            Edit address
          </Button>
          {item.reviewReason !== "COVERAGE_GAP" && item.reviewReason !== "REMOTE_JOB" && (
            <Button variant="secondary" disabled={pending} onClick={() => run({ action: "RETRY" }, "Lookup queued again")}>
              Retry lookup
            </Button>
          )}
          <Button
            variant="danger"
            disabled={pending}
            onClick={() => {
              if (window.confirm(`Close ${item.companyName} without a visit?`)) run({ action: "NO_VISIT" }, "Door closed");
            }}
          >
            Close: no visit
          </Button>
        </div>
      )}
    </article>
  );
}
