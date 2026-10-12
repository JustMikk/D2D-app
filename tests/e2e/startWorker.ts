// Starts the worker for e2e runs once the web server is up (it applies the migrations first).
const healthUrl = process.env.E2E_HEALTH_URL ?? "http://localhost:3100/api/v1/health";
const deadline = Date.now() + 5 * 60_000;

for (;;) {
  try {
    if ((await fetch(healthUrl)).ok) break;
  } catch {
    // not up yet
  }
  if (Date.now() > deadline) throw new Error(`Web server did not come up at ${healthUrl}`);
  await new Promise((r) => setTimeout(r, 1000));
}

await import("../../worker/index");

export {};
