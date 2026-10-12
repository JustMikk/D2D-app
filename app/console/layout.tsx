import Link from "next/link";
import { signOutAction } from "@/app/actions";
import { ThemeSwitcher } from "@/components/ui/ThemeSwitcher";
import { CONSOLE_ROLES, isAdmin } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { reviewCount } from "@/lib/services/review";
import { parsePreferences } from "@/lib/services/users";
import { ConsoleNav, type NavItem } from "./ConsoleNav";

// Manager console shell (design doc §7.2). Screens join the nav as their build steps land.
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser(CONSOLE_ROLES);
  const prefs = parsePreferences(user.preferences);
  const waiting = await reviewCount();
  const nav: NavItem[] = [
    { href: "/console/map", label: "Map" },
    { href: "/console/review", label: "Review", count: waiting },
    { href: "/console/doors", label: "Doors" },
    { href: "/console/reps", label: "Reps" },
    { href: "/console/metrics", label: "Metrics" },
    ...(isAdmin(user.role) ? [{ href: "/console/imports", label: "Imports" }] : []),
    ...(isAdmin(user.role) ? [{ href: "/console/settings", label: "Settings" }] : []),
  ];
  return (
    <div className="flex min-h-dvh min-w-[1024px] flex-col">
      <header className="flex h-14 items-center gap-8 border-b border-line bg-surface px-[var(--gutter-mgr)]">
        <Link href="/console" className="text-title-s">
          Canvass
        </Link>
        <ConsoleNav items={nav} />
        <div className="ml-auto flex items-center gap-4">
          <ThemeSwitcher initial={prefs.theme ?? "auto"} />
          <span className="text-body text-ink-2">
            {user.name} · {user.role.charAt(0) + user.role.slice(1).toLowerCase()}
          </span>
          <form action={signOutAction}>
            <button type="submit" className="text-label text-link underline-offset-4 hover:underline">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="flex-1 px-[var(--gutter-mgr)] py-6">{children}</main>
    </div>
  );
}
