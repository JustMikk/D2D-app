"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { acceptInviteAction, type AcceptState } from "./actions";

export function AcceptInviteForm({ token, suggestedName }: { token: string; suggestedName: string | null }) {
  const [state, action, pending] = useActionState<AcceptState, FormData>(acceptInviteAction.bind(null, token), {
    error: null,
    fieldErrors: {},
    name: suggestedName ?? "",
  });

  return (
    <form action={action} className="flex flex-col gap-5">
      {state.error && (
        <p role="alert" className="rounded-sm bg-red-bg px-4 py-3 text-body text-red-fg">
          {state.error}
        </p>
      )}
      <Field label="Your name" error={state.fieldErrors.name}>
        {(p) => <Input {...p} size="rep" name="name" autoComplete="name" required defaultValue={state.name} />}
      </Field>
      <Field label="Password" helper="At least 10 characters." error={state.fieldErrors.password}>
        {(p) => <Input {...p} size="rep" name="password" type="password" autoComplete="new-password" required />}
      </Field>
      <Field label="Confirm password" error={state.fieldErrors.confirm}>
        {(p) => <Input {...p} size="rep" name="confirm" type="password" autoComplete="new-password" required />}
      </Field>
      <Button type="submit" size="rep" block disabled={pending}>
        {pending ? "Setting password…" : "Set password"}
      </Button>
    </form>
  );
}
