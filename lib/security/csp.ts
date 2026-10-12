// Content Security Policy (backend spec §11): "a strict CSP (self, plus the OpenFreeMap tile and style hosts)".
// Scripts and styles run only with the per-request nonce (Next.js applies it to its own scripts and styles),
// so an injected <script> or <style> does nothing. Built here, apart from proxy.ts, so it can be tested.
// Relative on purpose: next.config.ts imports this file, and the config is compiled without the "@/" alias.
import { DEFAULT_STYLE_URL } from "../rep/tiles";

export type CspOptions = {
  nonce: string;
  /** Next.js dev mode needs eval for debugging; production does not. */
  dev: boolean;
  /** Origins the map loads its style, tiles, sprites and glyphs from. */
  mapOrigins: string[];
  /** Upgrade http subresources to https. Off for plain-http local runs. */
  upgradeInsecure: boolean;
};

/** The origin of a style URL, or null when it is not a valid URL. */
export function originOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

export function mapOriginsFor(styleUrl: string | undefined): string[] {
  return [...new Set([originOf(DEFAULT_STYLE_URL), originOf(styleUrl)].filter((o): o is string => o !== null))];
}

export function newNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

export function buildCsp({ nonce, dev, mapOrigins, upgradeInsecure }: CspOptions): string {
  const maps = mapOrigins.join(" ");
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    // The app uses no inline style attributes; the map library sets styles through the CSSOM, which CSP allows.
    `img-src 'self' blob: data: ${maps}`.trim(),
    "font-src 'self'",
    // Same-origin API, plus the map's tile, style and glyph requests.
    `connect-src 'self' ${maps}`.trim(),
    // The map draws in a blob worker; the service worker is /sw.js.
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(upgradeInsecure ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}

/** Headers every response gets (the CSP itself is per request, from proxy.ts). */
export const STATIC_SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // Browsers honor HSTS only over HTTPS, so sending it on a plain-http local run is harmless.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  // Location is the one sensor the app uses. Photos come through a file input, not the camera API.
  { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=(), payment=(), usb=()" },
];
