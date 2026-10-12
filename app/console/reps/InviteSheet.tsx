"use client";
// Invite dialog (PRD MGR-4, REP-1). Posts to /api/v1/invites. Until an email provider is set up (D-1),
// the manager copies the invite link and sends it; the link is shown once.
import { Copy, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";

const TIME_ZONES = [
  ["America/New_York", "Eastern"],
  ["America/Chicago", "Central"],
  ["America/Denver", "Mountain"],
  ["America/Phoenix", "Arizona"],
  ["America/Los_Angeles", "Pacific"],
  ["America/Anchorage", "Alaska"],
  ["Pacific/Honolulu", "Hawaii"],
] as const;

type Role = "REP" | "MANAGER" | "ADMIN" | "VIEWER";
type Errors = Record<string, string>;

export function InviteSheet({ canInviteAnyRole }: { canInviteAnyRole: boolean }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>("REP");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<{ inviteUrl: string; email: string } | null>(null);
  const [pending, setPending] = useState(false);
  const idempotencyKey = useRef<string>(crypto.randomUUID());
  const formRef = useRef<HTMLFormElement>(null);
  const toast = useToast();
  const router = useRouter();

  function reset() {
    setRole("REP");
    setErrors({});
    setFormError(null);
    setResult(null);
    idempotencyKey.current = crypto.randomUUID();
  }

  function close() {
    setOpen(false);
    reset();
  }

  async function submit(form: FormData) {
    setPending(true);
    setErrors({});
    setFormError(null);
    const email = String(form.get("email") ?? "");
    const body: Record<string, unknown> = { email, role };
    if (role === "REP") {
      body.rep = {
        name: String(form.get("name") ?? ""),
        timeZone: String(form.get("timeZone") ?? ""),
        baseAddress: String(form.get("baseAddress") ?? ""),
        ...(form.get("dailyCapacity") ? { dailyCapacity: Number(form.get("dailyCapacity")) } : {}),
      };
    }
    try {
      const res = await fetch("/api/v1/invites", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey.current },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        const details: { path: string; message: string }[] = data.error?.details ?? [];
        setErrors(Object.fromEntries(details.map((d) => [d.path.replace(/^rep\./, ""), d.message])));
        if (!details.length) setFormError(data.error?.message ?? "The invite could not be created.");
        return;
      }
      setResult({ inviteUrl: data.inviteUrl, email });
      toast.show("Invite created");
      router.refresh();
    } catch {
      setFormError("You're offline. Connect and try again.");
    } finally {
      setPending(false);
    }
  }

  async function copy() {
    if (!result) return;
    await navigator.clipboard.writeText(result.inviteUrl);
    toast.show("Link copied");
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <UserPlus aria-hidden="true" size={18} />
        Invite
      </Button>
      <Sheet
        open={open}
        onClose={close}
        title={result ? "Invite created" : "Invite someone"}
        footer={
          result ? (
            <Button variant="secondary" block onClick={close}>
              Done
            </Button>
          ) : (
            <Button block disabled={pending} onClick={() => formRef.current?.requestSubmit()}>
              {pending ? "Creating invite…" : "Create invite"}
            </Button>
          )
        }
      >
        {result ? (
          <div className="flex flex-col gap-4">
            <p className="text-body">
              Send this link to {result.email}. It works once and expires in 7 days. You won&apos;t see it again after closing.
            </p>
            <Field label="Invite link">
              {(p) => <Input {...p} readOnly value={result.inviteUrl} onFocus={(e) => e.currentTarget.select()} data-testid="invite-url" />}
            </Field>
            <Button variant="secondary" onClick={copy}>
              <Copy aria-hidden="true" size={18} />
              Copy link
            </Button>
          </div>
        ) : (
          <form
            ref={formRef}
            onSubmit={(e) => {
              // Not a form action: React 19 would reset the fields even when the invite comes back with errors.
              e.preventDefault();
              void submit(new FormData(e.currentTarget));
            }}
            className="flex flex-col gap-5">
            {formError && (
              <p role="alert" className="rounded-sm bg-red-bg px-4 py-3 text-body text-red-fg">
                {formError}
              </p>
            )}
            <Field label="Role">
              {(p) => (
                <Select {...p} name="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  <option value="REP">Rep</option>
                  {canInviteAnyRole && (
                    <>
                      <option value="MANAGER">Manager</option>
                      <option value="ADMIN">Admin</option>
                      <option value="VIEWER">Viewer</option>
                    </>
                  )}
                </Select>
              )}
            </Field>
            <Field label="Email" error={errors.email}>
              {(p) => <Input {...p} name="email" type="email" required autoComplete="off" />}
            </Field>
            {role === "REP" && (
              <>
                <Field label="Name" error={errors.name}>
                  {(p) => <Input {...p} name="name" required />}
                </Field>
                <Field label="Time zone" error={errors.timeZone}>
                  {(p) => (
                    <Select {...p} name="timeZone" defaultValue="America/Chicago">
                      {TIME_ZONES.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label} ({value})
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Deployment base" helper="Where the rep starts each day. A street address." error={errors.baseAddress}>
                  {(p) => <Input {...p} name="baseAddress" required placeholder="6101 Preston Rd, Plano, TX 75093" />}
                </Field>
                <Field label="Daily capacity" helper="Leave blank to use the default." error={errors.dailyCapacity}>
                  {(p) => <Input {...p} name="dailyCapacity" type="number" min={1} max={100} inputMode="numeric" />}
                </Field>
              </>
            )}
          </form>
        )}
      </Sheet>
    </>
  );
}
