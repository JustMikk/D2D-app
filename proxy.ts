import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, mapOriginsFor, newNonce } from "@/lib/security/csp";

// Next.js 16 calls this file "proxy" (it was "middleware"). It sets a Content-Security-Policy with a fresh
// nonce on every page request. Pages must render dynamically for the nonce to reach Next's own scripts;
// the root layout reads cookies, so they all do.
export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const csp = buildCsp({
    nonce,
    dev: process.env.NODE_ENV === "development",
    mapOrigins: mapOriginsFor(process.env.NEXT_PUBLIC_MAP_STYLE_URL),
    // Only when the app is served over https; upgrading would break a plain-http local run.
    upgradeInsecure: (process.env.APP_BASE_URL ?? "").startsWith("https://"),
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the JSON API, built assets, the service worker, icons or the manifest.
      source: "/((?!api/|_next/static|_next/image|favicon.ico|sw.js|icons/|manifest.webmanifest).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
