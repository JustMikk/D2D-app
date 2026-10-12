// Per test file: a private copy of the template database. lib/db creates its client lazily, so setting
// DATABASE_URL here, before any query, points every service at this copy.
import { randomUUID } from "node:crypto";
import { copyFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll } from "vitest";

const dir = resolve("data/test");
const file = resolve(dir, `${randomUUID()}.db`);
copyFileSync(resolve(dir, "template.db"), file);
process.env.DATABASE_URL = `file:${file}`;

afterAll(async () => {
  const { closeDb } = await import("@/lib/db");
  await closeDb();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
});
