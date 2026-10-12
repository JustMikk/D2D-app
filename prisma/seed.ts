// Creates the first admin when no users exist (backend spec §12).
// Run with `npm run db:seed` or `npx prisma db seed`.
import { existsSync } from "node:fs";
import { hash } from "@node-rs/argon2";
import { createPrismaClient, applyPragmas } from "../lib/db";
import { parseEnv } from "../lib/env";

if (existsSync(".env")) process.loadEnvFile(".env");

async function main() {
  const env = parseEnv(["DATABASE_URL", "SEED_ADMIN_EMAIL", "SEED_ADMIN_PASSWORD"] as const);
  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    await applyPragmas(prisma);
    const users = await prisma.user.count();
    if (users > 0) {
      console.log(`Seed skipped: ${users} user(s) already exist.`);
      return;
    }
    if (!env.SEED_ADMIN_EMAIL || !env.SEED_ADMIN_PASSWORD) {
      // A warning, not a failure: the web container runs this on every boot and must still start.
      console.warn("No users exist. Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD and restart to create the first admin.");
      return;
    }
    const admin = await prisma.user.create({
      data: {
        email: env.SEED_ADMIN_EMAIL.toLowerCase(),
        name: "Admin",
        role: "ADMIN",
        passwordHash: await hash(env.SEED_ADMIN_PASSWORD),
      },
    });
    await prisma.auditLog.create({
      data: { actorType: "SYSTEM", action: "user.seeded", entityType: "USER", entityId: admin.id },
    });
    console.log(`Created admin ${admin.email}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
