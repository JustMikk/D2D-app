// Form controls (design doc §8.3): label above in text-label, helper below in text-caption,
// errors in danger with a circle-alert icon, announced and linked to the field.
import { CircleAlert } from "lucide-react";
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

type FieldRenderProps = { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean };

export function Field({
  label,
  helper,
  error,
  children,
}: {
  label: string;
  helper?: ReactNode;
  error?: string | null;
  children: (props: FieldRenderProps) => ReactNode;
}) {
  const id = useId();
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;
  const describedBy = [helper ? helperId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-label text-ink">
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {helper && (
        <p id={helperId} className="text-caption text-ink-2">
          {helper}
        </p>
      )}
      <p id={errorId} aria-live="polite" className="text-caption text-danger empty:hidden">
        {error ? (
          <span className="inline-flex items-center gap-1">
            <CircleAlert aria-hidden="true" size={14} />
            {error}
          </span>
        ) : null}
      </p>
    </div>
  );
}

export type ControlSize = "rep" | "console";

const CONTROL =
  "w-full rounded-sm bg-surface text-ink placeholder:text-ink-3 outline-none focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2 aria-[invalid=true]:border-danger";
const CONTROL_SIZE: Record<ControlSize, string> = {
  rep: "h-12 px-3 text-body-l border-2 border-line-strong",
  console: "h-10 px-3 text-body border border-line-strong",
};

export function Input({ size = "console", className = "", ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: ControlSize }) {
  return <input className={`${CONTROL} ${CONTROL_SIZE[size]} ${className}`} {...rest} />;
}

export function Select({ size = "console", className = "", ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: ControlSize }) {
  return <select className={`${CONTROL} ${CONTROL_SIZE[size]} ${className}`} {...rest} />;
}
