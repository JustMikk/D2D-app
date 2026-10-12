"use client";

import { Copy, KeyRound } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { onSubmitWith } from "@/components/ui/form";
import { Field, Input } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";

const SCOPES = [
  { value: "intake:write", label: "intake:write", help: "Send prospects to the intake API" },
  { value: "crm:write", label: "crm:write", help: "Store Twenty IDs (n8n)" },
];

export function CreateKeyForm() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const toast = useToast();

  function submit(form: FormData) {
    setError(null);
    const name = String(form.get("name") ?? "");
    const scopes = form.getAll("scopes").map(String);
    start(async () => {
      const r = await createApiKeyAction(name, scopes);
      if (r.ok) {
        setCreated({ key: r.key, name: r.name });
        toast.show("API key created");
      } else setError(r.error);
    });
  }

  if (created) {
    return (
      <div className="flex flex-col gap-3 rounded-md border-2 border-outline bg-surface p-5">
        <p className="text-body">
          Copy the key for <span className="font-semibold">{created.name}</span> now. It is shown once and cannot be recovered.
        </p>
        <Field label="API key">
          {(p) => <Input {...p} readOnly value={created.key} onFocus={(e) => e.currentTarget.select()} data-testid="new-api-key" className="tnum" />}
        </Field>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(created.key);
              toast.show("Key copied");
            }}
          >
            <Copy aria-hidden="true" size={18} />
            Copy key
          </Button>
          <Button variant="quiet" onClick={() => setCreated(null)}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmitWith(submit)} className="flex flex-wrap items-end gap-4 rounded-md border border-line bg-surface p-5">
      <div className="w-72">
        <Field label="Key name" helper="Who uses it, e.g. Prospecting workflow">
          {(p) => <Input {...p} name="name" required maxLength={80} />}
        </Field>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-label">Scopes</legend>
        <div className="flex gap-4">
          {SCOPES.map((s) => (
            <label key={s.value} className="flex items-center gap-2 text-body" title={s.help}>
              <input type="checkbox" name="scopes" value={s.value} defaultChecked={s.value === "intake:write"} className="size-4 accent-[var(--action)]" />
              {s.label}
            </label>
          ))}
        </div>
      </fieldset>
      <Button type="submit" disabled={pending}>
        <KeyRound aria-hidden="true" size={18} />
        Create key
      </Button>
      {error && (
        <p role="alert" className="w-full text-body text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

export function RevokeButton({ id, name }: { id: string; name: string }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  return (
    <Button
      variant="danger"
      disabled={pending}
      onClick={() => {
        if (!window.confirm(`Revoke "${name}"? Anything using it stops working at once.`)) return;
        start(async () => {
          const r = await revokeApiKeyAction(id);
          toast.show(r.error ?? "Key revoked");
        });
      }}
    >
      Revoke
    </Button>
  );
}
