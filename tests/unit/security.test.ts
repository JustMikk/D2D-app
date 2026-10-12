import { describe, expect, it } from "vitest";
import { buildCsp, mapOriginsFor, newNonce, originOf, STATIC_SECURITY_HEADERS } from "@/lib/security/csp";

const base = { nonce: "abc123", dev: false, mapOrigins: ["https://tiles.openfreemap.org"], upgradeInsecure: false };
const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

describe("buildCsp", () => {
  it("allows scripts and styles only with the nonce, and never inline or eval in production", () => {
    const csp = buildCsp(base);
    expect(directive(csp, "script-src")).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(directive(csp, "style-src")).toBe("style-src 'self' 'nonce-abc123'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("allows eval in development only (React uses it for debugging)", () => {
    expect(directive(buildCsp({ ...base, dev: true }), "script-src")).toContain("'unsafe-eval'");
  });

  it("opens only what the map needs: its hosts, blob workers and images", () => {
    const csp = buildCsp(base);
    expect(directive(csp, "connect-src")).toBe("connect-src 'self' https://tiles.openfreemap.org");
    expect(directive(csp, "img-src")).toBe("img-src 'self' blob: data: https://tiles.openfreemap.org");
    expect(directive(csp, "worker-src")).toBe("worker-src 'self' blob:");
  });

  it("blocks framing, plugins, base-tag and form hijacking", () => {
    const csp = buildCsp(base);
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "default-src 'self'", "media-src 'none'"]) expect(csp).toContain(d);
  });

  it("upgrades insecure requests only when served over https", () => {
    expect(buildCsp(base)).not.toContain("upgrade-insecure-requests");
    expect(buildCsp({ ...base, upgradeInsecure: true })).toContain("upgrade-insecure-requests");
  });
});

describe("map origins and nonces", () => {
  it("always includes OpenFreeMap and adds a custom style's host once", () => {
    expect(mapOriginsFor(undefined)).toEqual(["https://tiles.openfreemap.org"]);
    expect(mapOriginsFor("https://maps.example.com/style.json")).toEqual(["https://tiles.openfreemap.org", "https://maps.example.com"]);
    expect(mapOriginsFor("https://tiles.openfreemap.org/styles/positron")).toEqual(["https://tiles.openfreemap.org"]);
    expect(mapOriginsFor("not a url")).toEqual(["https://tiles.openfreemap.org"]);
    expect(originOf("https://a.example/x?y=1")).toBe("https://a.example");
    expect(originOf(undefined)).toBeNull();
  });

  it("makes a different unguessable nonce each time", () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
    expect(newNonce()).not.toBe(a);
  });
});

describe("static security headers", () => {
  const get = (k: string) => STATIC_SECURITY_HEADERS.find((h) => h.key === k)?.value;
  it("covers sniffing, referrers, framing, transport and sensors", () => {
    expect(get("X-Content-Type-Options")).toBe("nosniff");
    expect(get("X-Frame-Options")).toBe("DENY");
    expect(get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(get("Strict-Transport-Security")).toMatch(/^max-age=\d+/);
    expect(get("Permissions-Policy")).toContain("geolocation=(self)");
    expect(get("Permissions-Policy")).toContain("camera=()");
  });
});
