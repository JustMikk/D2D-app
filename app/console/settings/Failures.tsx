"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { retryEventAction, retryJobAction } from "./actions";

export function RetryButton({ id, kind }: { id: string; kind: "job" | "event" }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  return (
    <Button
      variant="secondary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await (kind === "job" ? retryJobAction(id) : retryEventAction(id));
          toast.show(r.error ?? (kind === "job" ? "Job queued again" : "Event queued again"));
        })
      }
    >
      Retry
    </Button>
  );
}
