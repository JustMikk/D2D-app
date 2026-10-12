// Removes the throwaway databases left by earlier e2e runs. The current run's file is kept, because
// the web server may still have it open; the next run removes it.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export default function globalTeardown() {
  const dir = join("data", "e2e");
  const current = `run-${process.env.E2E_RUN_ID}.db`;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (/^run-\d+\.db(-wal|-shm)?$/.test(name) && !name.startsWith(current)) {
      rmSync(join(dir, name), { force: true });
    }
  }
}
