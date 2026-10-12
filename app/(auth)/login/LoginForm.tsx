"use client";

import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { loginAction, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, { error: null, email: "" });
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return (
    <form action={action} className="flex flex-col gap-5">
      {!online && (
        <p role="status" className="rounded-sm bg-amber-bg px-4 py-3 text-body text-amber-fg">
          Connect to sign in for the first time.
        </p>
      )}
      <Field label="Email">
        {(p) => <Input {...p} size="rep" name="email" type="email" autoComplete="email" required defaultValue={state.email} />}
      </Field>
      <Field label="Password" error={state.error}>
        {(p) => <Input {...p} size="rep" name="password" type="password" autoComplete="current-password" required />}
      </Field>
      <Button type="submit" size="rep" block disabled={pending || !online}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
