"use client";
// Sheets (design doc §8.6): slide up from the bottom (rep) or in from the right (console), radius-lg
// corners, shadow-3, a drag handle and a sticky footer. Built on <dialog> for focus trapping and Esc.
import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

export function Sheet({
  open,
  onClose,
  title,
  side = "right",
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  side?: "bottom" | "right";
  footer?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Unique per sheet: several sheets can be on one page, each labelled by its own title.
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const position =
    side === "bottom"
      ? "mt-auto mb-0 w-full max-w-[var(--content-max-rep)] mx-auto rounded-t-lg max-h-[90dvh]"
      : "ml-auto mr-0 h-dvh max-h-dvh w-full max-w-[480px] rounded-l-lg";

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby={titleId}
      className={`${position} z-[var(--z-sheet)] flex-col bg-surface p-0 text-ink shadow-3 backdrop:bg-scrim open:flex`}
    >
      {side === "bottom" && <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 rounded-pill bg-line" />}
      <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
        <h2 id={titleId} className="text-title-s">
          {title}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" className="grid size-10 place-items-center rounded-sm text-ink-2 hover:bg-surface-sunken">
          <X aria-hidden="true" size={20} />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      {footer && <footer className="sticky bottom-0 border-t border-line bg-surface px-6 py-4">{footer}</footer>}
    </dialog>
  );
}
