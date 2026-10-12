import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { ToastProvider } from "@/components/ui/Toast";
import { getSessionUser } from "@/lib/auth/session";
import { BRAND } from "@/lib/ui/brand";
import { parsePreferences } from "@/lib/services/users";
import { dataThemeFor, THEME_COOKIE } from "@/lib/ui/theme";
import { overpass } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Canvass",
  description: "Door-to-door field app for reps and managers",
  applicationName: "Canvass",
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
  // iOS: opens from the home screen without the browser bars.
  appleWebApp: { capable: true, title: "Canvass", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: BRAND.theme,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Day or dusk when the user picked one; otherwise no attribute, and the OS preference decides.
  // The cookie is per device; without one, fall back to the signed-in user's saved preference.
  const cookieTheme = (await cookies()).get(THEME_COOKIE)?.value;
  const user = cookieTheme ? null : await getSessionUser();
  const dataTheme = dataThemeFor(cookieTheme ?? (user ? parsePreferences(user.preferences).theme : undefined));
  return (
    <html lang="en" className={overpass.variable} data-theme={dataTheme}>
      <body className="min-h-dvh bg-bg text-ink">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
