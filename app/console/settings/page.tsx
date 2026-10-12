import { DateTime } from "luxon";
import { CircleCheck } from "lucide-react";
import { Chip } from "@/components/ui/Chip";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { workerStatus } from "@/lib/heartbeat";
import { listApiKeys } from "@/lib/services/apiKeys";
import { listJobs, listOutbox } from "@/lib/services/ops";
import { getSettings } from "@/lib/settings";
import { CreateKeyForm, RevokeButton } from "./ApiKeys";
import { RetryButton } from "./Failures";
import { SettingsForm } from "./SettingsForm";

const ago = (d: Date | string | null) => (d ? (DateTime.fromJSDate(new Date(d)).toRelative() ?? "") : "Never");

// Settings (PRD MGR-6, MGR-7, NTF-1). Admin only: tunables, schedule, integrations, API keys and the
// delivery log for anything that failed.
export default async function SettingsPage() {
  await requireUser(ADMIN_ROLES);
  const [settings, keys, failedJobs, failedEvents, pendingEvents, worker] = await Promise.all([
    getSettings(),
    listApiKeys(),
    listJobs({ status: "FAILED", limit: 25 }),
    listOutbox({ status: "FAILED", limit: 25 }),
    listOutbox({ status: "PENDING", limit: 1 }),
    workerStatus(),
  ]);
  const secretSet = Boolean(process.env.OUTBOUND_WEBHOOK_SECRET);

  return (
    <div className="flex max-w-[1100px] flex-col gap-10">
      <h1 className="text-title-l">Settings</h1>

      <section className="flex flex-wrap gap-3" aria-label="Status">
        <Chip tone={worker.alive ? "green" : "red"}>{worker.alive ? `Worker running, seen ${ago(worker.lastTickAt)}` : "Worker not running"}</Chip>
        <Chip tone={secretSet ? "green" : "amber"}>{secretSet ? "Webhook secret set" : "Webhook secret missing"}</Chip>
        <Chip tone={settings["webhooks.outboundUrl"] ? "green" : "amber"}>{settings["webhooks.outboundUrl"] ? "Webhook URL set" : "No webhook URL: events are waiting"}</Chip>
        {pendingEvents.items.length > 0 && <Chip tone="slate">Events waiting to send</Chip>}
      </section>

      <SettingsForm settings={settings} />

      <section className="flex flex-col gap-4" aria-labelledby="delivery">
        <div className="flex flex-col gap-1">
          <h2 id="delivery" className="text-title-m">
            Failed deliveries and jobs
          </h2>
          <p className="text-body text-ink-2">Events are retried for about 24 hours before they appear here. Jobs fail after 5 tries.</p>
        </div>
        {failedEvents.items.length === 0 && failedJobs.items.length === 0 ? (
          <p className="flex items-center gap-2 text-body">
            <CircleCheck aria-hidden="true" size={18} className="text-success" />
            Nothing has failed.
          </p>
        ) : (
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="border-b border-line text-left text-label text-ink-2">
                <th className="py-2 pr-4 font-semibold">What</th>
                <th className="py-2 pr-4 font-semibold">Tries</th>
                <th className="py-2 pr-4 font-semibold">Last error</th>
                <th className="py-2 pr-4 font-semibold">When</th>
                <th className="py-2 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {failedEvents.items.map((e) => (
                <tr key={e.id} className="border-b border-line align-top">
                  <td className="py-2.5 pr-4">Event {e.type}</td>
                  <td className="tnum py-2.5 pr-4">{e.attempts}</td>
                  <td className="max-w-[420px] break-words py-2.5 pr-4 text-ink-2">{e.lastError ?? "—"}</td>
                  <td className="py-2.5 pr-4 text-ink-2">{ago(e.createdAt)}</td>
                  <td className="py-2.5 text-right">
                    <RetryButton id={e.id} kind="event" />
                  </td>
                </tr>
              ))}
              {failedJobs.items.map((j) => (
                <tr key={j.id} className="border-b border-line align-top">
                  <td className="py-2.5 pr-4">Job {j.type}</td>
                  <td className="tnum py-2.5 pr-4">{j.attempts}</td>
                  <td className="max-w-[420px] break-words py-2.5 pr-4 text-ink-2">{j.lastError ?? "—"}</td>
                  <td className="py-2.5 pr-4 text-ink-2">{ago(j.updatedAt)}</td>
                  <td className="py-2.5 text-right">
                    <RetryButton id={j.id} kind="job" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="api-keys">
        <div className="flex flex-col gap-1">
          <h2 id="api-keys" className="text-title-m">
            API keys
          </h2>
          <p className="text-body text-ink-2">
            The prospecting workflow uses a key with <span className="font-semibold">intake:write</span> to send prospects. n8n uses{" "}
            <span className="font-semibold">crm:write</span> to store Twenty IDs.
          </p>
        </div>

        <CreateKeyForm />

        {keys.length === 0 ? (
          <p className="text-body text-ink-2">No API keys yet.</p>
        ) : (
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="border-b border-line text-left text-label text-ink-2">
                <th className="py-2 pr-4 font-semibold">Name</th>
                <th className="py-2 pr-4 font-semibold">Key</th>
                <th className="py-2 pr-4 font-semibold">Scopes</th>
                <th className="py-2 pr-4 font-semibold">Last used</th>
                <th className="py-2 pr-4 font-semibold">Created</th>
                <th className="py-2 pr-4 font-semibold">Status</th>
                <th className="py-2 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-b border-line">
                  <td className="py-2.5 pr-4 font-semibold">{k.name}</td>
                  <td className="tnum py-2.5 pr-4">{k.prefix}…</td>
                  <td className="py-2.5 pr-4">{k.scopes.join(", ")}</td>
                  <td className="tnum py-2.5 pr-4 text-ink-2">{ago(k.lastUsedAt)}</td>
                  <td className="py-2.5 pr-4 text-ink-2">
                    {DateTime.fromJSDate(k.createdAt).toLocaleString(DateTime.DATE_MED)} by {k.createdBy}
                  </td>
                  <td className="py-2.5 pr-4">{k.revokedAt ? <Chip tone="slate">Revoked</Chip> : <Chip tone="green">Active</Chip>}</td>
                  <td className="py-2.5 text-right">{!k.revokedAt && <RevokeButton id={k.id} name={k.name} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
