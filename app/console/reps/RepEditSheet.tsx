"use client";
// Edit a rep (PRD MGR-4, ASN-7): profile, deployment base (geocoded on save), working days, days off,
// and deactivation.
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { onSubmitWith } from "@/components/ui/form";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { WEEKDAYS } from "@/lib/domain/enums";
import { US_TIME_ZONES } from "@/lib/ui/settingsMeta";

export type RepRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  timeZone: string;
  baseAddress: string | null;
  baseLocated: boolean;
  dailyCapacity: number;
  workdays: string[];
  dayStartLocal: string;
  active: boolean;
  daysOff: { date: string; reason: string | null }[];
  todayDate: string;
};

const DAY_LABEL: Record<string, string> = { MON: "Mon", TUE: "Tue", WED: "Wed", THU: "Thu", FRI: "Fri", SAT: "Sat", SUN: "Sun" };

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

export function RepEditSheet({ rep, canEdit }: { rep: RepRow; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [workdays, setWorkdays] = useState<string[]>(rep.workdays);
  const router = useRouter();
  const toast = useToast();

  function fail(data: { error?: { message?: string; details?: { path: string; message: string }[] } }) {
    const details = data.error?.details ?? [];
    setFields(Object.fromEntries(details.map((d) => [d.path, d.message])));
    setError(details.length ? null : (data.error?.message ?? "That did not work."));
  }

  async function save(form: FormData) {
    setPending(true);
    setError(null);
    setFields({});
    const capacity = Number(form.get("dailyCapacity"));
    const { ok, data } = await call(`/api/v1/reps/${rep.id}`, "PATCH", {
      name: String(form.get("name") ?? ""),
      phone: String(form.get("phone") ?? "") || null,
      timeZone: String(form.get("timeZone") ?? ""),
      baseAddress: String(form.get("baseAddress") ?? ""),
      dailyCapacity: Number.isFinite(capacity) && capacity > 0 ? capacity : undefined,
      workdays,
      dayStartLocal: String(form.get("dayStartLocal") ?? ""),
    }).catch(() => ({ ok: false, data: { error: { message: "You're offline. Connect and try again." } } }));
    setPending(false);
    if (!ok) return fail(data);
    toast.show("Rep saved");
    setOpen(false);
    router.refresh();
  }

  async function setActive(active: boolean) {
    if (!active && !window.confirm(`Deactivate ${rep.name}? They are signed out, and today's and upcoming doors go back to be assigned to other reps.`)) return;
    setPending(true);
    const { ok, data } = await call(`/api/v1/reps/${rep.id}`, "PATCH", { active });
    setPending(false);
    if (!ok) return fail(data);
    toast.show(active ? `${rep.name} reactivated` : `${rep.name} deactivated`);
    setOpen(false);
    router.refresh();
  }

  async function addDayOff(form: FormData) {
    setPending(true);
    setError(null);
    const { ok, data } = await call(`/api/v1/reps/${rep.id}/unavailability`, "POST", { dates: [String(form.get("date") ?? "")], reason: String(form.get("reason") ?? "") || undefined });
    setPending(false);
    if (!ok) return fail(data);
    toast.show(data.reassigned ? `Day off added. ${data.reassigned} doors will be reassigned.` : "Day off added");
    router.refresh();
  }

  async function removeDayOff(date: string) {
    const { ok, data } = await call(`/api/v1/reps/${rep.id}/unavailability/${date}`, "DELETE");
    if (!ok) return fail(data);
    toast.show("Day off removed");
    router.refresh();
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} aria-label={`${canEdit ? "Edit" : "View"} ${rep.name}`}>
        {canEdit ? "Edit" : "View"}
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={rep.name}
        footer={
          canEdit && (
            <Button block type="submit" form={`rep-form-${rep.id}`} disabled={pending}>
              {pending ? "Saving…" : "Save rep"}
            </Button>
          )
        }
      >
        <div className="flex flex-col gap-8">
          {error && (
            <p role="alert" className="rounded-sm bg-red-bg px-4 py-3 text-body text-red-fg">
              {error}
            </p>
          )}
          <form id={`rep-form-${rep.id}`} onSubmit={onSubmitWith((f) => void save(f))} className="flex flex-col gap-5">
            <fieldset disabled={!canEdit} className="flex flex-col gap-5">
              <Field label="Name" error={fields.name}>
                {(p) => <Input {...p} name="name" required defaultValue={rep.name} />}
              </Field>
              <Field label="Phone" error={fields.phone}>
                {(p) => <Input {...p} name="phone" type="tel" defaultValue={rep.phone ?? ""} />}
              </Field>
              <Field label="Time zone" error={fields.timeZone}>
                {(p) => (
                  <Select {...p} name="timeZone" defaultValue={rep.timeZone}>
                    {[...new Set([...US_TIME_ZONES, rep.timeZone])].map((z) => (
                      <option key={z} value={z}>
                        {z}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field
                label="Deployment base"
                helper={rep.baseLocated ? "Where the rep starts each day. Changing it re-locates the address." : "Not located yet. Save to look it up."}
                error={fields.baseAddress}
              >
                {(p) => <Input {...p} name="baseAddress" required defaultValue={rep.baseAddress ?? ""} placeholder="6101 Preston Rd, Plano, TX 75093" />}
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Doors per day" error={fields.dailyCapacity}>
                  {(p) => <Input {...p} name="dailyCapacity" type="number" min={1} max={100} required defaultValue={rep.dailyCapacity} />}
                </Field>
                <Field label="Day starts at" error={fields.dayStartLocal}>
                  {(p) => <Input {...p} name="dayStartLocal" type="time" required defaultValue={rep.dayStartLocal} />}
                </Field>
              </div>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-label">Working days</legend>
                <div className="flex flex-wrap gap-3">
                  {WEEKDAYS.map((d) => (
                    <label key={d} className="flex items-center gap-1.5 text-body">
                      <input
                        type="checkbox"
                        checked={workdays.includes(d)}
                        onChange={(e) => setWorkdays((w) => (e.target.checked ? [...w, d] : w.filter((x) => x !== d)))}
                        className="size-4 accent-[var(--action)]"
                      />
                      {DAY_LABEL[d]}
                    </label>
                  ))}
                </div>
                {fields.workdays && <p className="text-caption text-danger">{fields.workdays}</p>}
              </fieldset>
            </fieldset>
          </form>

          <section className="flex flex-col gap-3" aria-labelledby={`off-${rep.id}`}>
            <h3 id={`off-${rep.id}`} className="text-label">
              Days off
            </h3>
            {rep.daysOff.length === 0 ? (
              <p className="text-body text-ink-2">No upcoming days off.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {rep.daysOff.map((d) => (
                  <li key={d.date} className="flex items-center justify-between text-body">
                    <span>
                      <span className="tnum">{d.date}</span>
                      {d.reason ? ` · ${d.reason}` : ""}
                    </span>
                    {canEdit && (
                      <button type="button" onClick={() => void removeDayOff(d.date)} aria-label={`Remove ${d.date}`} className="grid size-10 place-items-center rounded-sm text-ink-2 hover:bg-surface-sunken">
                        <Trash2 aria-hidden="true" size={18} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <form onSubmit={onSubmitWith((f) => void addDayOff(f))} className="flex items-end gap-2">
                <Field label="Add a day off" error={fields.dates}>
                  {(p) => <Input {...p} name="date" type="date" required min={rep.todayDate} />}
                </Field>
                <Field label="Reason">{(p) => <Input {...p} name="reason" maxLength={200} />}</Field>
                <Button type="submit" variant="secondary" disabled={pending} className="mb-[22px]">
                  Add
                </Button>
              </form>
            )}
          </section>

          {canEdit && (
            <section className="flex flex-col gap-2 border-t border-line pt-5">
              {rep.active ? (
                <Button variant="danger" onClick={() => void setActive(false)} disabled={pending}>
                  Deactivate rep
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => void setActive(true)} disabled={pending}>
                  Reactivate rep
                </Button>
              )}
            </section>
          )}
        </div>
      </Sheet>
    </>
  );
}
