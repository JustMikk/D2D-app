"use client";

import { ArrowDown, ArrowUp, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AssignSheet, type RepChoice } from "@/components/console/AssignSheet";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

/** Queue a re-plan; the worker plans the route, so the page refreshes a moment later. */
export function DayActions({ repId, date, canReplan }: { repId: string; date: string; canReplan: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  async function replan() {
    setPending(true);
    try {
      const res = await fetch(`/api/v1/reps/${repId}/replan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date }) });
      const data = await res.json();
      if (!res.ok) return void toast.show(data.error?.message ?? "The re-plan could not be queued.");
      toast.show("Re-plan queued");
      setTimeout(() => router.refresh(), 3000);
    } catch {
      toast.show("You're offline. Connect and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Button variant="secondary" onClick={() => void replan()} disabled={pending || !canReplan}>
      <RefreshCw aria-hidden="true" size={18} />
      Re-plan
    </Button>
  );
}

export function StopActions({ doorId, doorName, date, repId, reps }: { doorId: string; doorName: string; date: string; repId: string; reps: RepChoice[] }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);

  async function unassign() {
    const reason = window.prompt(`Take ${doorName} off this route? Why?`);
    if (!reason?.trim()) return;
    const res = await fetch(`/api/v1/doors/${doorId}/unassign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
    const data = await res.json().catch(() => ({}));
    toast.show(res.ok ? "Door unassigned" : (data.error?.message ?? "That did not work."));
    if (res.ok) router.refresh();
  }

  return (
    <div className="flex justify-end gap-2">
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Reassign
      </Button>
      <Button variant="quiet" onClick={() => void unassign()}>
        Unassign
      </Button>
      <AssignSheet open={open} onClose={() => setOpen(false)} doorId={doorId} doorName={doorName} reps={reps} defaultRepId={repId} defaultDate={date} />
    </div>
  );
}

/** Move a stop up or down the route (PRD MGR-5). Buttons rather than only dragging, so it works by keyboard and on touch. */
export function MoveButtons({ repId, date, name, openIds, index }: { repId: string; date: string; name: string; openIds: string[]; index: number }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  async function move(by: -1 | 1) {
    const next = [...openIds];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    setPending(true);
    try {
      const res = await fetch(`/api/v1/reps/${repId}/day/${date}/order`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ assignmentIds: next }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.show(data.error?.message ?? "The order couldn't be changed.");
      toast.show("Order changed");
      router.refresh();
    } catch {
      toast.show("You're offline. Connect and try again.");
    } finally {
      setPending(false);
    }
  }

  const btn = "grid size-10 place-items-center rounded-sm text-ink-2 hover:bg-surface-sunken disabled:opacity-40";
  return (
    <div className="flex">
      <button type="button" className={btn} aria-label={`Move ${name} up`} disabled={pending || index === 0} onClick={() => void move(-1)}>
        <ArrowUp aria-hidden="true" size={18} />
      </button>
      <button type="button" className={btn} aria-label={`Move ${name} down`} disabled={pending || index === openIds.length - 1} onClick={() => void move(1)}>
        <ArrowDown aria-hidden="true" size={18} />
      </button>
    </div>
  );
}
