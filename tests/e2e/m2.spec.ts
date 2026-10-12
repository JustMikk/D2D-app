// Milestone M2 in the browser: a rep is set up, a prospect is assigned automatically, and a manager works
// the day board: reassign, unassign, edit the rep and a setting.
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

type Reps = { items: { id: string; name: string }[] };

test("automatic assignment, then the day board, rep edit and settings", async ({ page, playwright }, testInfo) => {
  test.setTimeout(120_000);
  await signIn(page);

  // Setup through the API: a rep based in Dallas (located when invited), then a prospect in Dallas.
  const invite = await page.request.post("/api/v1/invites", {
    data: { email: "dana.e2e@example.com", role: "REP", rep: { name: "Dana Dallas", timeZone: "America/Chicago", baseAddress: "2450 Commerce St, Dallas, TX 75226" } },
  });
  expect(invite.status()).toBe(201);
  const token = (await invite.json()).inviteUrl.split("/invite/")[1];
  const anonymous = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
  expect((await anonymous.post(`/api/v1/invites/${token}/accept`, { data: { name: "Dana Dallas", password: "bluebonnet-route-42" } })).status()).toBe(201);
  await anonymous.dispose();

  // The prospect arrives after Dana exists, so she is the nearest rep. (Lone Star went to Jordan in the
  // first spec, and the engine never moves a door that already has a rep.)
  const keyRes = await page.request.post("/api/v1/api-keys", { data: { name: "E2E assignment", scopes: ["intake:write"] } });
  const { key } = await keyRes.json();
  const intake = await page.request.post("/api/v1/intake/prospects", { headers: { authorization: `Bearer ${key}` }, data: pick("Harvest Table Catering") });
  const { doorId } = await intake.json();
  expect(doorId).toBeTruthy();

  // The worker assigns the door to the nearest rep, within seconds.
  type Detail = { door: { status: string; currentAssignment: { repId: string; repName: string; scheduledFor: string } | null } };
  const detail = async (): Promise<Detail> => (await page.request.get(`/api/v1/doors/${doorId}`)).json();
  await expect.poll(async () => (await detail()).door.currentAssignment?.repName, { timeout: 45_000 }).toBe("Dana Dallas");
  const { repId, scheduledFor } = (await detail()).door.currentAssignment!;

  // Edit the rep: capacity, and a day off far in the future.
  await page.goto("/console/reps");
  await page.getByRole("button", { name: "Edit Dana Dallas" }).click();
  const sheet = page.getByRole("dialog", { name: "Dana Dallas" });
  await sheet.getByLabel("Doors per day").fill("5");
  await sheet.getByLabel("Add a day off").fill("2030-01-07");
  await sheet.getByLabel("Reason").fill("Conference");
  await sheet.getByRole("button", { name: "Add", exact: true }).click();
  await expect(sheet.getByText("2030-01-07")).toBeVisible();
  await page.getByRole("button", { name: "Save rep" }).click();
  await expect(page.getByRole("row", { name: /Dana Dallas/ })).toContainText("5");

  // Day board: the stop is there, assigned by the engine.
  await page.goto(`/console/reps/${repId}/day/${scheduledFor}`);
  await expect(page.getByRole("heading", { name: "Dana Dallas" })).toBeVisible();
  const row = page.getByRole("row", { name: /Harvest Table Catering/ });
  await expect(row).toContainText("Engine");

  // Reassign to Jordan (invited in the first spec): the stop leaves Dana's board and joins Jordan's.
  const reps: Reps = await (await page.request.get("/api/v1/reps")).json();
  const jordan = reps.items.find((r) => r.name === "Jordan Rivera");
  if (!jordan) throw new Error("Jordan Rivera should exist from the first spec");
  await row.getByRole("button", { name: "Reassign" }).click();
  const assign = page.getByRole("dialog", { name: "Assign door" });
  await assign.getByLabel("Rep").selectOption(jordan.id);
  await assign.getByLabel("Date").fill(scheduledFor);
  await assign.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByRole("row", { name: /Harvest Table Catering/ })).toHaveCount(0);
  expect((await detail()).door.currentAssignment).toMatchObject({ repId: jordan.id, scheduledFor });

  await page.goto(`/console/reps/${jordan.id}/day/${scheduledFor}`);
  const jordanRow = page.getByRole("row", { name: /Harvest Table Catering/ });
  await expect(jordanRow).toContainText("Manager");

  // Unassign: back to Ready, and the engine leaves it alone.
  page.once("dialog", (d) => void d.accept("Wrong territory"));
  await jordanRow.getByRole("button", { name: "Unassign" }).click();
  await expect(page.getByRole("row", { name: /Harvest Table Catering/ })).toHaveCount(0);
  expect((await detail()).door.status).toBe("GEOCODED");

  // Settings: change a tunable, and see an invalid one refused.
  await page.goto("/console/settings");
  const drive = page.getByLabel(/Longest drive to a door/);
  await drive.fill("90");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/Longest drive to a door/)).toHaveValue("90");
  await page.getByLabel("Same-day cutoff").fill("10:30");
  await page.getByLabel(/Longest drive to a door/).fill("4");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Some settings need attention" })).toBeVisible();
  await expect(page.getByLabel(/Longest drive to a door/)).toHaveValue("4"); // nothing was saved, and the input is kept
});
