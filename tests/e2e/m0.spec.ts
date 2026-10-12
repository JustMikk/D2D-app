// Milestone M0 (PRD §11): a manager signs in and invites a rep; tokens render in both themes.
import { devices, expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN } from "../../playwright.config";

const INTERSTATE_BLUE = "rgb(21, 101, 192)"; // #1565C0, day action
const DUSK_ACTION = "rgb(91, 155, 240)"; // #5B9BF0, dusk action
const WHITE = "rgb(255, 255, 255)";
const DUSK_ON_ACTION = "rgb(17, 24, 29)"; // #11181D

async function colors(page: Page, name: string | RegExp) {
  return page.getByRole("button", { name, exact: true }).evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, fg: s.color };
  });
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("admin signs in, invites a rep, the rep sets a password and lands on Today", async ({ page, browser }) => {
  // Wrong password first: an error, no sign-in.
  await signIn(page, E2E_ADMIN.email, "not-the-password");
  await expect(page.getByText("That email and password don't match")).toBeVisible();

  await signIn(page, E2E_ADMIN.email, E2E_ADMIN.password);
  // The console opens on the live map; Reps is one click away.
  await expect(page).toHaveURL(/\/console\/map$/);
  await page.getByRole("link", { name: "Reps" }).click();
  await expect(page).toHaveURL(/\/console\/reps$/);
  await expect(page.getByRole("heading", { name: "Reps", exact: true })).toBeVisible();

  // Day theme: the primary action is Interstate blue with white text.
  expect(await colors(page, "Invite")).toEqual({ bg: INTERSTATE_BLUE, fg: WHITE });

  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Invite someone" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Email").fill("jordan.e2e@example.com");
  await sheet.getByLabel("Name").fill("Jordan Rivera");
  await sheet.getByLabel("Deployment base").fill("6101 Preston Rd, Plano, TX 75093");
  await page.getByRole("button", { name: "Create invite" }).click();

  const link = page.getByTestId("invite-url");
  await expect(link).toHaveValue(/\/invite\/[A-Za-z0-9_-]{43}$/);
  const inviteUrl = await link.inputValue();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("cell", { name: "jordan.e2e@example.com" })).toBeVisible(); // pending invites

  // The rep, on a phone.
  const repContext = await browser.newContext({ ...devices["Pixel 7"] });
  const rep = await repContext.newPage();
  await rep.goto(inviteUrl);
  await expect(rep.getByRole("heading", { name: "Set your password" })).toBeVisible();
  await expect(rep.getByLabel("Your name")).toHaveValue("Jordan Rivera");
  await rep.getByLabel("Password", { exact: true }).fill("short");
  await rep.getByLabel("Confirm password").fill("short");
  await rep.getByRole("button", { name: "Set password" }).click();
  await expect(rep.getByText("Use at least 10 characters.")).toBeVisible();

  await rep.getByLabel("Password", { exact: true }).fill("bluebonnet-route-42");
  await rep.getByLabel("Confirm password").fill("bluebonnet-route-42");
  await rep.getByRole("button", { name: "Set password" }).click();

  // First sign-in: the monitoring notice, then Today.
  await expect(rep.getByRole("heading", { name: "How Canvass uses your location" })).toBeVisible();
  expect(await colors(rep, "I understand")).toEqual({ bg: INTERSTATE_BLUE, fg: WHITE });
  await rep.getByRole("button", { name: "I understand" }).click();
  await expect(rep.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(rep).toHaveURL(/\/today$/);

  // The invite link is now spent.
  await rep.goto(inviteUrl);
  await expect(rep.getByRole("heading", { name: "This link has expired" })).toBeVisible();

  // Dusk theme, chosen in Settings, survives a reload.
  await rep.goto("/today");
  await rep.getByRole("button", { name: "Settings" }).click();
  await rep.getByRole("radio", { name: "Dusk" }).click();
  await expect(rep.locator("html")).toHaveAttribute("data-theme", "dusk");
  await rep.reload();
  await expect(rep.locator("html")).toHaveAttribute("data-theme", "dusk");
  const dusk = await rep.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    const probe = document.createElement("div");
    probe.style.background = "var(--action)";
    probe.style.color = "var(--on-action)";
    document.body.append(probe);
    const p = getComputedStyle(probe);
    const out = { bg: p.backgroundColor, fg: p.color, page: getComputedStyle(document.body).backgroundColor, ink: s.getPropertyValue("--ink").trim() };
    probe.remove();
    return out;
  });
  expect(dusk).toMatchObject({ bg: DUSK_ACTION, fg: DUSK_ON_ACTION, page: "rgb(17, 24, 29)" });

  // A rep cannot open the console.
  await rep.goto("/console/reps");
  await expect(rep).toHaveURL(/\/today$/);
  await repContext.close();

  // Back in the console, the rep is listed.
  await page.reload();
  const jordan = page.getByRole("row", { name: /Jordan Rivera/ });
  await expect(jordan).toContainText("America/Chicago");
  await expect(jordan).toContainText("6101 Preston Rd, Plano, TX 75093");
  await expect(jordan).not.toContainText("Not located"); // the base was geocoded when the invite was created
});

test("signed-out visitors are sent to sign in, and the API answers 401", async ({ page, request }) => {
  await page.goto("/console/reps");
  await expect(page).toHaveURL(/\/login$/);
  const res = await request.get("/api/v1/me");
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
});
