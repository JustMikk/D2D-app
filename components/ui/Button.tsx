// Buttons (design doc §8.2). Primary uses the Interstate-blue action fill with on-action text.
// Rep size is 56px with a 2px ink outline for sunlight; console size is 40px.
import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "rep" | "console";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-sm text-label font-bold transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] " +
  "active:translate-y-px active:shadow-[inset_0_2px_0_var(--outline)] disabled:pointer-events-none disabled:border-transparent disabled:bg-surface-sunken disabled:text-ink-3";

const VARIANTS: Record<ButtonVariant, Record<ButtonSize, string>> = {
  primary: {
    rep: "h-14 px-5 bg-action text-on-action border-2 border-outline",
    console: "h-10 px-4 bg-action text-on-action",
  },
  secondary: {
    rep: "h-14 px-5 bg-surface text-ink border-2 border-outline",
    console: "h-10 px-4 bg-surface text-ink border border-line-strong",
  },
  quiet: {
    rep: "h-12 px-3 bg-transparent text-link",
    console: "h-9 px-2 bg-transparent text-link",
  },
  danger: {
    rep: "h-12 px-4 bg-surface text-danger border border-danger",
    console: "h-10 px-4 bg-surface text-danger border border-danger",
  },
};

export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "console", extra = ""): string {
  return `${BASE} ${VARIANTS[variant][size]} ${extra}`.trim();
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container width. */
  block?: boolean;
};

export function Button({ variant = "primary", size = "console", block, className = "", type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={buttonClasses(variant, size, `${block ? "w-full" : ""} ${className}`)} {...rest} />;
}
