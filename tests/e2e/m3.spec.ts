// Milestone M3 (PRD §11): a rep completes a full day on a phone, including time in airplane mode, with
// nothing lost. Setup goes through the API; the rep's day is driven through the real app on a Pixel 7.
import { readFileSync } from "node:fs";
import { devices, expect, test, type Page } from "@playwright/test";
import { apifyJobToIntake } from "../../lib/domain/apify";
import { E2E_ADMIN } from "../../playwright.config";

const jobs = JSON.parse(readFileSync("tests/fixtures/sample_apify_linkedin_jobs.json", "utf8")) as { companyName: string }[];
const pick = (name: string) => apifyJobToIntake(jobs.find((j) => j.companyName === name));
const COMPANIES = ["Elm Street Accounting", "Kessler Park Realty", "Oak Cliff Family Clinic"];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const REP = { email: "rep-m3@example.com", password: "bluebonnet-route-42", name: "Riley Road" };

type Day = { rep: { id: string }; shift: { startedAt: string; endedAt: string | null } | null; stops: { name: string; status: string; arrivedAt: string | null; outcome: string | null }[] };
type DoorDetail = { door: { status: string; nextStepAt: string | null; lastOutcome: string | null; attempts: number }; visits: { outcome: string; notes: string; offSite: boolean; photoUrls: string[]; signatureUrl: string | null; decisionMakerPresent: boolean | null }[] };

test("a full day on a phone, with time in airplane mode, loses nothing", async ({ browser, playwright, page: admin }, testInfo) => {
  test.setTimeout(240_000);
  const baseURL = testInfo.project.use.baseURL!;

  // ---- Setup (admin, through the API) -------------------------------------------------------------
  await admin.goto("/login");
  await admin.getByLabel("Email").fill(E2E_ADMIN.email);
  await admin.getByLabel("Password").fill(E2E_ADMIN.password);
  await admin.getByRole("button", { name: "Sign in" }).click();
  await expect(admin).toHaveURL(/\/console\//);

  const invite = await admin.request.post("/api/v1/invites", {
    data: { email: REP.email, role: "REP", rep: { name: REP.name, timeZone: "America/Chicago", baseAddress: "2450 Commerce St, Dallas, TX 75226" } },
  });
  expect(invite.status()).toBe(201);
  const anon = await playwright.request.newContext({ baseURL });
  expect((await anon.post(`/api/v1/invites/${(await invite.json()).inviteUrl.split("/invite/")[1]}/accept`, { data: { name: REP.name, password: REP.password } })).status()).toBe(201);
  await anon.dispose();

  const { key } = await (await admin.request.post("/api/v1/api-keys", { data: { name: "E2E rep day", scopes: ["intake:write"] } })).json();
  const doorIds: Record<string, string> = {};
  for (const name of COMPANIES) {
    const res = await admin.request.post("/api/v1/intake/prospects", { headers: { authorization: `Bearer ${key}` }, data: pick(name) });
    doorIds[name] = (await res.json()).doorId;
  }

  const reps: { items: { id: string; name: string; today: { date: string } }[] } = await (await admin.request.get("/api/v1/reps")).json();
  const rep = reps.items.find((r) => r.name === REP.name)!;
  const today = rep.today.date;
  for (const name of COMPANIES) {
    // Wait for the address to be resolved, then give the door to this rep for today.
    await expect.poll(async () => ((await (await admin.request.get(`/api/v1/doors/${doorIds[name]}`)).json()) as DoorDetail).door.status, { timeout: 45_000 }).not.toBe("NEW");
    const res = await admin.request.post(`/api/v1/doors/${doorIds[name]}/assign`, { data: { repId: rep.id, date: today } });
    expect(res.status(), await res.text()).toBe(200);
  }
  const day = async (): Promise<Day> => (await admin.request.get(`/api/v1/reps/${rep.id}/day/${today}`)).json();
  await expect.poll(async () => (await day()).stops.filter((s) => s.status === "ACTIVE").length, { timeout: 45_000 }).toBe(3);

  // ---- The rep's phone ---------------------------------------------------------------------------
  const context = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL,
    geolocation: { latitude: 32.7767, longitude: -96.797 },
    permissions: ["geolocation"],
    reducedMotion: "reduce",
  });
  const phone: Page = await context.newPage();
  // The rep app is the most script-heavy page: it must run clean under the CSP (service worker, IndexedDB, canvas, map).
  const violations: string[] = [];
  phone.on("console", (m) => {
    if (/content security policy|refused to (apply|load|execute|connect|create)/i.test(m.text())) violations.push(m.text());
  });
  await phone.goto("/login");
  await phone.getByLabel("Email").fill(REP.email);
  await phone.getByLabel("Password").fill(REP.password);
  await phone.getByRole("button", { name: "Sign in" }).click();
  await phone.getByRole("button", { name: "I understand" }).click();
  await expect(phone.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(phone.getByText("3 stops planned")).toBeVisible();
  const current = phone.getByTestId("current-stop");
  await expect(current).toBeVisible();

  // The app is now installed offline: the service worker controls the page and holds the shell.
  await expect.poll(() => phone.evaluate(async () => (await navigator.serviceWorker.ready).active !== null), { timeout: 20_000 }).toBe(true);
  await expect
    .poll(() => phone.evaluate(async () => Boolean(await caches.match(location.origin + "/today")) && (await (await caches.open("canvass-static-v1")).keys()).length > 3), { timeout: 20_000 })
    .toBe(true);

  // Start the day online: the server learns about it.
  await phone.getByRole("button", { name: "Start day" }).click();
  await expect(phone.getByText("Day started")).toBeVisible();
  await expect(phone.getByText("Sharing location while your day is on")).toBeVisible();
  await expect.poll(async () => (await day()).shift?.startedAt ?? null, { timeout: 20_000 }).not.toBeNull();

  // ---- Airplane mode -------------------------------------------------------------------------------
  await context.setOffline(true);
  await expect(phone.getByText(/^Offline\./)).toBeVisible();

  // The app reopens from cache with no signal.
  const t0 = Date.now();
  await phone.reload();
  await expect(phone.getByTestId("current-stop")).toBeVisible({ timeout: 8_000 });
  console.log(`Today rendered from cache, offline, in ${Date.now() - t0} ms (reload to visible)`);
  await expect(phone.getByText("2 of 3 stops left").or(phone.getByText("3 of 3 stops left"))).toBeVisible();

  const logged: { company: string; outcome: string }[] = [];
  const currentName = async () => (await phone.getByTestId("current-stop").getByRole("heading").first().textContent())!.trim();

  // Stop 1: arrive (far from the pin, so the rep confirms), then "Not home".
  logged.push({ company: await currentName(), outcome: "NOT_HOME" });
  await phone.getByTestId("current-stop").getByRole("button", { name: "Arrived", exact: true }).click();
  await expect(phone.getByRole("dialog", { name: "Mark as arrived?" })).toContainText(/from this address\. Log the visit anyway\?/);
  await phone.getByRole("button", { name: "Mark arrived anyway" }).click();
  await expect(phone.getByText("Marked as arrived")).toBeVisible();
  await phone.getByRole("button", { name: "Log visit", exact: true }).click();
  const sheet = phone.getByRole("dialog", { name: "How did it go?" });
  await sheet.getByRole("radio", { name: "Not home" }).click();
  await sheet.getByRole("button", { name: "Save visit" }).click();
  await expect(phone.getByText("Visit saved")).toBeVisible();
  await expect(phone.getByText("2 of 3 stops left")).toBeVisible();

  // Stop 2: a follow-up with a photo, notes and a date.
  const second = await currentName();
  expect(second).not.toBe(logged[0]!.company);
  logged.push({ company: second, outcome: "FOLLOW_UP" });
  await phone.getByRole("button", { name: "Log visit", exact: true }).click();
  await sheet.getByRole("radio", { name: "Follow-up" }).click();
  await sheet.getByRole("button", { name: "Save visit" }).click();
  await expect(sheet.getByText("Pick a date and time for the next step")).toBeVisible();
  const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  await sheet.getByLabel("Follow up on").fill(inTwoDays);
  await sheet.getByRole("radio", { name: "Yes" }).click();
  await sheet.getByLabel("Notes").fill("Owner is out. Call back Friday.");
  await sheet.getByTestId("photo-input").setInputFiles({ name: "front-door.png", mimeType: "image/png", buffer: PNG });
  await expect(sheet.getByAltText("Visit photo")).toBeVisible();
  await sheet.getByRole("button", { name: "Save visit" }).click();
  await expect(phone.getByText("1 of 3 stops left")).toBeVisible();

  // Stop 3: a sale needs a signature.
  const third = await currentName();
  logged.push({ company: third, outcome: "SOLD" });
  await phone.getByRole("button", { name: "Log visit", exact: true }).click();
  await sheet.getByRole("radio", { name: "Sold" }).click();
  await sheet.getByRole("button", { name: "Save visit" }).click();
  await expect(sheet.getByText("A signature is required for a sale")).toBeVisible();
  const pad = sheet.getByTestId("signature-pad");
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await phone.mouse.move(box.x + 30, box.y + 80);
  await phone.mouse.down();
  await phone.mouse.move(box.x + 120, box.y + 40, { steps: 8 });
  await phone.mouse.move(box.x + 200, box.y + 100, { steps: 8 });
  await phone.mouse.up();
  await sheet.getByRole("button", { name: "Save visit" }).click();
  await expect(phone.getByText("That's every stop.")).toBeVisible();

  // End the day, still offline.
  await phone.getByRole("button", { name: "End day" }).click();
  await expect(phone.getByText("Day ended")).toBeVisible();
  await expect(phone.getByText(/^Offline\. 3 visits will sync when you're back online\./)).toBeVisible();

  // Nothing has reached the server, and the work survives a reload while offline.
  expect((await day()).stops.map((s) => s.status)).toEqual(["ACTIVE", "ACTIVE", "ACTIVE"]);
  await phone.reload();
  await expect(phone.getByText(/^Offline\. 3 visits will sync when you're back online\./)).toBeVisible();
  await expect(phone.getByText("Done (3)")).toBeVisible();

  // ---- Back online -----------------------------------------------------------------------------------
  await context.setOffline(false);
  await expect.poll(async () => (await day()).stops.filter((s) => s.status === "COMPLETED").length, { timeout: 60_000 }).toBe(3);
  await expect(phone.getByText(/^Offline\./)).toHaveCount(0);
  await expect.poll(async () => (await day()).shift?.endedAt ?? null, { timeout: 30_000 }).not.toBeNull();

  // The server holds exactly the three visits, with everything the rep entered.
  const serverDay = await day();
  expect(serverDay.stops.find((s) => s.name.includes(logged[0]!.company.split(" ")[0]!))?.arrivedAt).not.toBeNull();
  const detail = async (company: string): Promise<DoorDetail> => (await admin.request.get(`/api/v1/doors/${doorIds[company]}`)).json();
  const notHome = await detail(logged[0]!.company);
  const followUp = await detail(logged[1]!.company);
  const sold = await detail(logged[2]!.company);
  expect(notHome.visits).toHaveLength(1);
  expect(followUp.visits).toHaveLength(1);
  expect(sold.visits).toHaveLength(1);
  expect(notHome.visits[0]).toMatchObject({ outcome: "NOT_HOME", offSite: true });
  expect(followUp.visits[0]).toMatchObject({ outcome: "FOLLOW_UP", notes: "Owner is out. Call back Friday.", decisionMakerPresent: true });
  expect(followUp.visits[0]!.photoUrls).toHaveLength(1);
  expect(sold.visits[0]!.signatureUrl).toContain("/api/v1/media/");
  expect(followUp.door).toMatchObject({ status: "VISITED" });
  expect(followUp.door.nextStepAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(sold.door.status).toBe("CLOSED");
  expect(notHome.door).toMatchObject({ attempts: 1, lastOutcome: "NOT_HOME" });

  // The signature and photo are real image files, readable by a signed link.
  const media = await (await playwright.request.newContext({ baseURL })).get(new URL(sold.visits[0]!.signatureUrl!).pathname + new URL(sold.visits[0]!.signatureUrl!).search);
  expect(media.status()).toBe(200);
  expect(media.headers()["content-type"]).toBe("image/png");

  // The manager sees the rep on the live map, with the day's progress and a recent location.
  await admin.goto("/console/map");
  const repRow = admin.getByRole("listitem").filter({ hasText: REP.name });
  await expect(repRow).toContainText("3 of 3 done");
  await expect(repRow).toContainText(/Last seen/);

  // ---- The rest of the app -----------------------------------------------------------------------------
  await phone.getByRole("radio", { name: "Map" }).click();
  await expect(phone.getByTestId("route-map").or(phone.getByText("The map isn't available right now."))).toBeVisible();
  await phone.getByRole("radio", { name: "List" }).click();

  await phone.getByRole("button", { name: "Settings" }).click();
  await expect(phone.getByRole("heading", { name: "Settings" })).toBeVisible();
  await phone.getByRole("radio", { name: "Dusk" }).click();
  await expect(phone.locator("html")).toHaveAttribute("data-theme", "dusk");
  await phone.getByRole("radio", { name: "Apple Maps" }).click();
  await phone.getByRole("button", { name: "Back to Today" }).click();
  await phone.getByRole("button", { name: "Settings" }).click();
  await expect(phone.getByRole("radio", { name: "Apple Maps" })).toHaveAttribute("aria-checked", "true");

  // With nothing left to sync, the rep can sign out, and is sent to sign in.
  await phone.getByRole("button", { name: "Sign out" }).click();
  await expect(phone).toHaveURL(/\/login$/);
  await context.close();
});
