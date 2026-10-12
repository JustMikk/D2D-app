"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = { href: string; label: string; count?: number };

export function ConsoleNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Console" className="flex h-full items-stretch gap-1">
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-1.5 border-b-2 px-3 text-label ${active ? "border-action text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
          >
            {item.label}
            {item.count !== undefined && item.count > 0 && (
              <span className="tnum rounded-pill bg-amber-bg px-1.5 text-caption text-amber-fg" aria-label={`${item.count} waiting`}>
                {item.count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
