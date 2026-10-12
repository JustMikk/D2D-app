"use client";
// Toasts (design doc §8.6): surface-inverse, ink-inverse text, 4 seconds, one optional action.
// Copy is the past tense of the action: "Visit saved", "Invite created".
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type Toast = { id: number; message: string; action?: { label: string; onClick: () => void } };
type ToastApi = { show: (message: string, action?: Toast["action"]) => void };

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback<ToastApi["show"]>((message, action) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--bar-height)+env(safe-area-inset-bottom)+12px)] z-[var(--z-toast)] flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((t) => (
          <div key={t.id} role="status" className="pointer-events-auto flex w-full max-w-[440px] items-center justify-between gap-4 rounded-md bg-surface-inverse px-4 py-3 text-body text-ink-inverse shadow-2">
            <span>{t.message}</span>
            {t.action && (
              <button type="button" onClick={t.action.onClick} className="text-label font-bold text-ink-inverse underline underline-offset-4">
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
