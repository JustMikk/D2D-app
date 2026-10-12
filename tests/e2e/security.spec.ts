// Backend spec §11: a strict CSP, Permissions-Policy and HSTS. The browser is the judge: every console page
// is loaded under the real policy, and any violation the browser reports fails the test.
import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN } from "../../playwright.config";

/** Collect what the browser says about blocked content, from now on. */
function watchViolations(page: Page): string[] {
  const seen: string[] = [];
  page.on("console", (m) => {
    if (/content security policy|refused to (apply|load|execute|connect|create)/i.test(m.text())) seen.push(m.text());
  });
  page.on("pageerror", (e) => {
    if (/content security policy/i.test(e.message)) seen.push(e.message);
  });
  return seen;
}

test("pages carry a nonce-based CSP, and Next.js stamps the nonce on its own scripts", async ({ request }) => {
  const res = await request.get("/login");
  expect(res.status()).toBe(200);
  const csp = res.headers()["content-security-policy"]!;
  const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
  expect(csp).toContain("script-src 'self' 'nonce-");
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).toContain("https://tiles.openfreemap.org");

  const html = await res.text();
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.every((s) => s.includes(`nonce="${nonce}"`))).toBe(true);

  // A fresh nonce for every request.
  const again = (await request.get("/login")).headers()["content-security-policy"]!;
  expect(/'nonce-([^']+)'/.exec(again)![1]).not.toBe(nonce);
});

test("every response has the static security headers; the API has no page policy; the service worker is never cached", async ({ request }) => {
  const page = (await request.get("/login")).headers();
  expect(page["x-content-type-options"]).toBe("nosniff");
  expect(page["x-frame-options"]).toBe("DENY");
  expect(page["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(page["strict-transport-security"]).toMatch(/max-age=31536000/);
  expect(page["permissions-policy"]).toContain("geolocation=(self)");
  expect(page["x-powered-by"]).toBeUndefined();

  const api = (await request.get("/api/v1/health")).headers();
  expect(api["x-content-type-options"]).toBe("nosniff");
  expect(api["content-security-policy"]).toBeUndefined();

  const sw = (await request.get("/sw.js")).headers();
  expect(sw["cache-control"]).toContain("no-cache");
  expect(sw["service-worker-allowed"]).toBe("/");
});

test("the whole console works under the policy, with no violations", async ({ page }) => {
  const violations = watchViolations(page);
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_ADMIN.email);
  await page.getByLabel("Password").fill(E2E_ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/console\/map$/);

  // The map starts a blob worker and fetches from the tile host: both are allowed by name.
  await expect(page.getByRole("heading", { name: "Map", exact: true })).toBeVisible();
  for (const [path, heading] of [
    ["/console/review", "Review"],
    ["/console/doors", "Doors"],
    ["/console/reps", "Reps"],
    ["/console/settings", "Settings"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  // A sheet, a form and a theme switch exercise client code and class-driven styling.
  await page.goto("/console/reps");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Invite someone" })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("radio", { name: "Dusk" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dusk");

  expect(violations).toEqual([]);
});
