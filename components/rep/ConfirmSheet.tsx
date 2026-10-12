"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";

/** A bottom sheet that asks one question with two big buttons. */
export function ConfirmSheet({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onCancel}
      side="bottom"
      title={title}
      footer={
        <div className="flex flex-col gap-2">
          <Button size="rep" block onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <Button size="rep" variant="secondary" block onClick={onCancel}>
            {cancelLabel}
          </Button>
        </div>
      }
    >
      <div className="text-body-l text-ink-2">{children}</div>
    </Sheet>
  );
}
