// Prisma 7 config: the datasource URL lives here instead of in schema.prisma.
// Prisma 7 no longer loads .env on its own, so load it here when present.
import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "file:./data/canvass.db",
  },
});
