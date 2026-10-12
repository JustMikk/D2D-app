"use client";

import { Ban, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { DateTime } from "luxon";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { onSubmitWith } from "@/components/ui/form";
import { useToast } from "@/components/ui/Toast";

type Entry = { id: string; kind: "COMPANY" | "ADDRESS"; label: string; note: string | null; createdAt: string };

export function DoNotKnockSection({ entries }: { entries: Entry[] }) {
  const router = useRouter();
  const toast = useToast();
  const [kind, setKind] = useState<"COMPANY" | "ADDRESS">("COMPANY");
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function add(form: FormData) {
    setBusy(true);
    setError(null);
    setFields({});
    const body = kind === "COMPANY" ? { kind, company: String(form.get("company") ?? ""), note: String(form.get("note") ?? "") || undefined } : { kind, street: String(form.get("street") ?? ""), zip: String(form.get("zip") ?? ""), note: String(form.get("note") ?? "") || undefined };
    const res = await fetch("/api/v1/do-not-knock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" }).catch(() => null);
    setBusy(false);
    if (!res) return setError("You're offline. Connect and try again.");
    const data = await res.json();
    if (!res.ok) {
      const details: { path: string; message: string }[] = data.error?.details ?? [];
      setFields(Object.fromEntries(details.map((d) => [d.path, d.message])));
      if (!details.length) setError(data.error?.message ?? "That couldn't be added.");
      return;
    }
    toast.show(data.closedDoors ? `Added. ${data.closedDoors} open ${data.closedDoors === 1 ? "door" : "doors"} closed.` : "Added to the list");
    router.refresh();
  }

  async function remove(entry: Entry) {
    if (!window.confirm(`Remove ${entry.label}? New prospects there will be accepted again. Doors already closed stay closed.`)) return;
    const res = await fetch(`/api/v1/do-not-knock/${entry.id}`, { method: "DELETE", credentials: "same-origin" });
    toast.show(res.ok ? "Removed" : "That couldn't be removed");
    if (res.ok) router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <form key={kind} onSubmit={onSubmitWith((f) => void add(f))} className="flex flex-wrap items-end gap-4 rounded-md border border-line bg-surface p-5">
        <Field label="Type">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as "COMPANY" | "ADDRESS")}>
              <option value="COMPANY">Company</option>
              <option value="ADDRESS">Address</option>
            </Select>
          )}
        </Field>
        {kind === "COMPANY" ? (
          <div className="w-80">
            <Field label="Company name or website" error={fields.company}>
              {(p) => <Input {...p} name="company" required placeholder="Acme Plumbing, or acmeplumbing.com" />}
            </Field>
          </div>
        ) : (
          <>
            <div className="w-72">
              <Field label="Street" error={fields.street}>
                {(p) => <Input {...p} name="street" required placeholder="500 N Main St" />}
              </Field>
            </div>
            <div className="w-32">
              <Field label="ZIP" error={fields.zip}>
                {(p) => <Input {...p} name="zip" required inputMode="numeric" />}
              </Field>
            </div>
          </>
        )}
        <div className="w-64">
          <Field label="Note" helper="Optional">
            {(p) => <Input {...p} name="note" maxLength={300} />}
          </Field>
        </div>
        <Button type="submit" disabled={busy}>
          <Ban aria-hidden="true" size={18} />
          Add
        </Button>
        {error && (
          <p role="alert" className="w-full text-body text-danger">
            {error}
          </p>
        )}
      </form>

      {entries.length === 0 ? (
        <p className="text-body text-ink-2">Nothing on the list.</p>
      ) : (
        <table className="w-full border-collapse text-body">
          <thead>
            <tr className="border-b border-line text-left text-label text-ink-2">
              <th className="py-2 pr-4 font-semibold">Type</th>
              <th className="py-2 pr-4 font-semibold">Entry</th>
              <th className="py-2 pr-4 font-semibold">Note</th>
              <th className="py-2 pr-4 font-semibold">Added</th>
              <th className="py-2 font-semibold">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-line">
                <td className="py-2.5 pr-4">{e.kind === "COMPANY" ? "Company" : "Address"}</td>
                <td className="py-2.5 pr-4 font-semibold">{e.label}</td>
                <td className="py-2.5 pr-4 text-ink-2">{e.note ?? "—"}</td>
                <td className="py-2.5 pr-4 text-ink-2">{DateTime.fromISO(e.createdAt).toLocaleString(DateTime.DATE_MED)}</td>
                <td className="py-2.5 text-right">
                  <button type="button" onClick={() => void remove(e)} aria-label={`Remove ${e.label}`} className="grid size-10 place-items-center rounded-sm text-ink-2 hover:bg-surface-sunken">
                    <Trash2 aria-hidden="true" size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
