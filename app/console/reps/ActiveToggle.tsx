"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { setUserActiveAction } from "./actions";

export function ActiveToggle({ userId, name, active }: { userId: string; name: string; active: boolean }) {
  const [pending, start] = useTransition();
  const toast = useToast();

  function toggle() {
    if (active && !window.confirm(`Deactivate ${name}? They will be signed out everywhere.`)) return;
    start(async () => {
      const { error } = await setUserActiveAction(userId, !active);
      toast.show(error ?? (active ? `${name} deactivated` : `${name} reactivated`));
    });
  }

  return (
    <Button variant={active ? "danger" : "secondary"} onClick={toggle} disabled={pending}>
      {active ? "Deactivate" : "Reactivate"}
    </Button>
  );
}
