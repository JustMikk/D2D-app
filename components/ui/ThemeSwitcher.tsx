"use client";
// Theme switching (design doc §11.2): data-theme on <html> is "day" or "dusk", or absent for automatic
// (OS preference). The choice is kept in a cookie so the server renders the right theme, and saved to
// the user's preferences when signed in.
import { Moon, Sun, SunMoon } from "lucide-react";
import { useState } from "react";
import { THEME_COOKIE, type ThemeChoice } from "@/lib/ui/theme";

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=31536000; samesite=lax`;
  // The rep app's automatic mode (dusk after local sunset) listens for this.
  window.dispatchEvent(new Event("canvass-theme-change"));
}

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "day", label: "Day", Icon: Sun },
  { value: "dusk", label: "Dusk", Icon: Moon },
  { value: "auto", label: "Automatic", Icon: SunMoon },
];

export function ThemeSwitcher({ initial, save = true, size = "console" }: { initial: ThemeChoice; save?: boolean; size?: "rep" | "console" }) {
  const [choice, setChoice] = useState<ThemeChoice>(initial);

  function pick(next: ThemeChoice) {
    setChoice(next);
    applyTheme(next);
    if (save) {
      void fetch("/api/v1/me/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: next }),
      });
    }
  }

  const height = size === "rep" ? "h-12" : "h-9";
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-sm border border-line-strong bg-surface p-0.5">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={choice === value}
          onClick={() => pick(value)}
          className={`${height} inline-flex items-center gap-1.5 rounded-xs px-3 text-label ${choice === value ? "bg-surface-inverse text-ink-inverse" : "text-ink-2"}`}
        >
          <Icon aria-hidden="true" size={16} />
          {label}
        </button>
      ))}
    </div>
  );
}
