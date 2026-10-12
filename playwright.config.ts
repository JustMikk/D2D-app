import { defineConfig, devices } from "@playwright/test";

// End-to-end tests (backend spec §13). Each run gets a brand-new database file (created by a plain,
// non-destructive `prisma migrate deploy`) seeded with a known admin, so no existing data is ever reset.
// Tests open phone-sized contexts for the rep app themselves.
const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;
// Set once in the main process; worker processes inherit it, so every process agrees on the file.
process.env.E2E_RUN_ID ??= String(Date.now());
const E2E_DB = `file:./data/e2e/run-${process.env.E2E_RUN_ID}.db`;

export const E2E_ADMIN = { email: "e2e-admin@example.com", password: "e2e-admin-password-1" };

// Both processes share the run's database and use the city-level fake instead of Google.
const SHARED_ENV = { DATABASE_URL: E2E_DB, APP_BASE_URL: BASE_URL, CANVASS_FAKE_GOOGLE: "1" };

export default defineConfig({
  testDir: "tests/e2e",
  globalTeardown: "./tests/e2e/globalTeardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? BASE_URL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          // A production build: closer to what ships, and steadier than the dev server under test load.
          command: `npx prisma migrate deploy && npx tsx prisma/seed.ts && npx next build && npx next start -p ${PORT}`,
          url: `${BASE_URL}/api/v1/health`,
          reuseExistingServer: false,
          timeout: 300_000,
          env: { ...SHARED_ENV, NEXT_DIST_DIR: ".next-e2e", SEED_ADMIN_EMAIL: E2E_ADMIN.email, SEED_ADMIN_PASSWORD: E2E_ADMIN.password },
        },
        {
          // The worker resolves addresses (city-level fake Google) and delivers nothing outbound.
          command: "npx tsx tests/e2e/startWorker.ts",
          wait: { stdout: /\[worker\] .* started/ },
          reuseExistingServer: false,
          timeout: 360_000,
          env: { ...SHARED_ENV, E2E_HEALTH_URL: `${BASE_URL}/api/v1/health` },
        },
      ],
});
