// Shared by the server (root layout reads the cookie) and the client (ThemeSwitcher writes it).
// Keep it out of "use client" modules: a server component importing a value from one gets a
// client reference, not the value.
export type ThemeChoice = "day" | "dusk" | "auto";

export const THEME_COOKIE = "canvass-theme";

/** The data-theme attribute for a stored choice; undefined means automatic (OS preference). */
export function dataThemeFor(value: string | undefined): "day" | "dusk" | undefined {
  return value === "day" || value === "dusk" ? value : undefined;
}
