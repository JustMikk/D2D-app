import { DateTime } from "luxon";
import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { Chip } from "@/components/ui/Chip";
import { CONSOLE_ROLES, canManage, isAdmin } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { listPendingInvites } from "@/lib/services/invites";
import { listReps } from "@/lib/services/reps";
import { listUsers } from "@/lib/services/users";
import { ActiveToggle } from "./ActiveToggle";
import { InviteSheet } from "./InviteSheet";
import { RepEditSheet } from "./RepEditSheet";

const ROLE_LABEL = { ADMIN: "Admin", MANAGER: "Manager", REP: "Rep", VIEWER: "Viewer" } as const;
const ago = (d: Date | null) => (d ? (DateTime.fromJSDate(d).toRelative() ?? "") : "Never");

// Reps and team (PRD MGR-4, MGR-5): field reps with today's progress, the day board, profile editing
// and days off; pending invites; the console team.
export default async function RepsPage() {
  const user = await requireUser(CONSOLE_ROLES);
  const [reps, users, invites] = await Promise.all([listReps(), listUsers(), canManage(user.role) ? listPendingInvites() : Promise.resolve([])]);
  const team = users.filter((u) => u.role !== "REP");
  const manage = canManage(user.role);

  return (
    <div className="flex max-w-[1200px] flex-col gap-10">
      <div className="flex items-center justify-between">
        <h1 className="text-title-l">Reps</h1>
        {manage && <InviteSheet canInviteAnyRole={isAdmin(user.role)} />}
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-title-m">Field reps ({reps.length})</h2>
        {reps.length === 0 ? (
          <p className="text-body text-ink-2">No reps yet. Invite one to get started.</p>
        ) : (
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="border-b border-line text-left text-label text-ink-2">
                <th className="py-2 pr-4 font-semibold">Name</th>
                <th className="py-2 pr-4 font-semibold">Today</th>
                <th className="py-2 pr-4 font-semibold">Time zone</th>
                <th className="py-2 pr-4 font-semibold">Deployment base</th>
                <th className="py-2 pr-4 font-semibold">Per day</th>
                <th className="py-2 pr-4 font-semibold">Status</th>
                <th className="py-2 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {reps.map((r) => (
                <tr key={r.id} className="border-b border-line align-middle">
                  <td className="py-3 pr-4">
                    <Link href={`/console/reps/${r.id}/day/${r.today.date}`} className="font-semibold hover:underline">
                      {r.name}
                    </Link>
                    <div className="text-caption text-ink-3">Signed in {ago(r.lastLoginAt)}</div>
                  </td>
                  <td className="tnum py-3 pr-4">{r.today.total === 0 ? "No stops" : `${r.today.done} of ${r.today.total} done`}</td>
                  <td className="py-3 pr-4">{r.timeZone}</td>
                  <td className="py-3 pr-4">
                    {r.baseAddress ?? "—"}
                    {!r.baseLocated && (
                      <span className="mt-1 flex items-center gap-1 text-caption text-amber-fg">
                        <CircleAlert aria-hidden="true" size={14} />
                        Not located: this rep gets no doors
                      </span>
                    )}
                  </td>
                  <td className="tnum py-3 pr-4">{r.dailyCapacity}</td>
                  <td className="py-3 pr-4">
                    {!r.active ? <Chip tone="slate">Deactivated</Chip> : r.onShift ? <Chip tone="green">On shift</Chip> : <Chip tone="slate">Off shift</Chip>}
                  </td>
                  <td className="flex items-center justify-end gap-2 py-3">
                    <Link href={`/console/reps/${r.id}/day/${r.today.date}`} className="text-label text-link underline-offset-4 hover:underline">
                      Day board
                    </Link>
                    <RepEditSheet rep={{ ...r, todayDate: r.today.date }} canEdit={manage} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {invites.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-title-m">Pending invites ({invites.length})</h2>
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="border-b border-line text-left text-label text-ink-2">
                <th className="py-2 pr-4 font-semibold">Email</th>
                <th className="py-2 pr-4 font-semibold">Role</th>
                <th className="py-2 pr-4 font-semibold">Expires</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => (
                <tr key={i.id} className="border-b border-line">
                  <td className="py-3 pr-4">{i.email}</td>
                  <td className="py-3 pr-4">{ROLE_LABEL[i.role as keyof typeof ROLE_LABEL] ?? i.role}</td>
                  <td className="tnum py-3 pr-4">{DateTime.fromJSDate(i.expiresAt).toRelative()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-title-m">Console team ({team.length})</h2>
        <table className="w-full border-collapse text-body">
          <thead>
            <tr className="border-b border-line text-left text-label text-ink-2">
              <th className="py-2 pr-4 font-semibold">Name</th>
              <th className="py-2 pr-4 font-semibold">Email</th>
              <th className="py-2 pr-4 font-semibold">Role</th>
              <th className="py-2 pr-4 font-semibold">Last sign-in</th>
              <th className="py-2 pr-4 font-semibold">Status</th>
              {isAdmin(user.role) && (
                <th className="py-2 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {team.map((u) => (
              <tr key={u.id} className="border-b border-line">
                <td className="py-3 pr-4 font-semibold">{u.name}</td>
                <td className="py-3 pr-4 text-ink-2">{u.email}</td>
                <td className="py-3 pr-4">{ROLE_LABEL[u.role]}</td>
                <td className="tnum py-3 pr-4 text-ink-2">{ago(u.lastLoginAt)}</td>
                <td className="py-3 pr-4">{u.active ? <Chip tone="green">Active</Chip> : <Chip tone="slate">Deactivated</Chip>}</td>
                {isAdmin(user.role) && <td className="py-3 text-right">{u.id !== user.id && <ActiveToggle userId={u.id} name={u.name} active={u.active} />}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
