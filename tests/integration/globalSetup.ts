// Builds one template database by applying the migrations (so tests exercise them); each test file copies it (see setup.ts).
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export const TEST_DB_DIR = resolve("data/test");
export const TEMPLATE_DB = resolve(TEST_DB_DIR, "template.db");

export default function globalSetup() {
  rmSync(TEST_DB_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DB_DIR, { recursive: true });
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: `file:${TEMPLATE_DB}` },
    stdio: "pipe",
  });
  if (!existsSync(TEMPLATE_DB)) throw new Error(`prisma migrate deploy did not create ${TEMPLATE_DB}`);
  return () => rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
