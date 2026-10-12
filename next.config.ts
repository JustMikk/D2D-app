import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./lib/security/csp";

const nextConfig: NextConfig = {
  // Native modules stay on the Node side; route handlers never run on Edge (backend spec §1).
  serverExternalPackages: ["better-sqlite3", "@node-rs/argon2"],
  poweredByHeader: false,
  // End-to-end runs build into their own folder so they can run next to a developer's `next dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async headers() {
    return [
      { source: "/:path*", headers: STATIC_SECURITY_HEADERS },
      {
        // The service worker must always be re-checked, or a fix to it never reaches phones.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
