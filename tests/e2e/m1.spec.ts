// Milestone M1 in the browser: an admin creates an API key, prospects arrive through the intake API,
// the worker resolves addresses, and a manager clears the review queue.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { apifyJobToIntake } from "../../lib/domain/apify";
import { E2E_ADMIN } from "../../playwright.config";

const jobs = JSON.parse(readFileSync("tests/fixtures/sample_apify_linkedin_jobs.json", "utf8")) as { companyName: string }[];
const pick = (name: string) => apifyJobToIntake(jobs.find((j) => j.companyName === name));

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_ADMIN.email);
  await page.getByLabel("Password").fill(E2E_ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/console\//);
}

test("API key → intake → address resolution → review queue cleared", async ({ page, request }) => {
  await signIn(page);

  // Settings: create a key; it is shown once.
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Key name").fill("Prospecting workflow");
  await page.getByRole("button", { name: "Create key" }).click();
  const key = await page.getByTestId("new-api-key").inputValue();
  expect(key).toMatch(/^cvs_[A-Za-z0-9_-]{43}$/);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("cell", { name: "Prospecting workflow" })).toBeVisible();

  // Intake: one clean door and two that need a decision.
  for (const name of ["Lone Star Freight Solutions", "Red River Logistics", "Silverline Packaging"]) {
    const res = await request.post("/api/v1/intake/prospects", { headers: { authorization: `Bearer ${key}` }, data: pick(name) });
    expect(res.status()).toBe(201);
  }
  const dup = await request.post("/api/v1/intake/prospects", { headers: { authorization: `Bearer ${key}` }, data: pick("Red River Logistics") });
  expect(await dup.json()).toMatchObject({ status: "duplicate" });

  // The worker resolves addresses within a few seconds.
  await expect(async () => {
    await page.goto("/console/review");
    await expect(page.getByText("2 doors need an address decision")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: /Review/ })).toContainText("2");

  // Red River: Grand Prairie office, Houston job. Use the company address anyway.
  const redRiver = page.getByRole("article", { name: "Red River Logistics" });
  await expect(redRiver).toContainText("Company address is far from the job city");
  await expect(redRiver).toContainText("2601 Great Southwest Pkwy");
  await redRiver.getByRole("button", { name: "Use company address" }).click();
  await expect(page.getByText("1 door needs an address decision")).toBeVisible();

  // Silverline: no street. A wrong city is rejected; the right one is pinned.
  const silverline = page.getByRole("article", { name: "Silverline Packaging" });
  await silverline.getByRole("button", { name: "Edit address" }).click();
  await silverline.getByLabel("Street").fill("1500 Gus Thomasson Rd");
  await silverline.getByLabel("City").fill("Nowhere");
  await silverline.getByLabel("State").fill("TX");
  await silverline.getByLabel("ZIP").fill("75150");
  await silverline.getByRole("button", { name: "Save address" }).click();
  await expect(silverline.getByRole("alert")).toContainText("could not be pinned exactly");
  // What the manager typed is still there after the error.
  await expect(silverline.getByLabel("Street")).toHaveValue("1500 Gus Thomasson Rd");
  await silverline.getByLabel("City").fill("Mesquite");
  await silverline.getByRole("button", { name: "Save address" }).click();
  await expect(page.getByText("No doors need a decision")).toBeVisible();

  // Doors: search, open the drawer, read the timeline.
  await page.getByRole("link", { name: "Doors" }).click();
  await page.getByLabel("Search").fill("Red River");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("link", { name: "Red River Logistics" }).click();
  const drawer = page.getByRole("dialog", { name: "Red River Logistics" });
  // The worker has since assigned it to a rep, or flagged that none is nearby (the e2e reps vary by run order).
  await expect(drawer).toContainText(/Assigned|Scheduled|No rep nearby|Ready/);
  await expect(drawer).toContainText("Created from intake");
  await expect(drawer).toContainText("Sent to review");
  await expect(drawer).toContainText("Review resolved");
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  await expect(drawer).toBeHidden();
});
