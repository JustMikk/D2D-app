// Prisma singleton over better-sqlite3, with the pragmas from backend spec §2.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient, type Prisma } from "./generated/prisma/client";

/** A client usable inside or outside a $transaction. Services take this so callers can compose them. */
export type Db = PrismaClient | Prisma.TransactionClient;

export const SQLITE_PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
] as const;

/**
 * Is this SQLite telling us the database was busy? Two shapes: waiting longer than busy_timeout for the
 * write lock, and SQLITE_BUSY_SNAPSHOT, where a transaction that has read tries to write after another
 * connection committed. SQLite refuses the second one at once and the busy timeout never applies to it.
 * Prisma reports both as P1008 with the SQLite code in the driver error.
 */
export function isBusyError(error: unknown): boolean {
  const e = error as { code?: string; message?: string; meta?: { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } } } } | null;
  const cause = e?.meta?.driverAdapterError?.cause;
  if (typeof cause?.originalCode === "string" && cause.originalCode.startsWith("SQLITE_BUSY")) return true;
  return e?.code === "P1008" && /database is locked|SQLITE_BUSY/i.test(`${e.message ?? ""} ${cause?.originalMessage ?? ""}`);
}

const BUSY_RETRIES = 6;

/**
 * The web app and the worker are two processes writing to one SQLite file. A read-then-write transaction
 * that another process overtakes cannot be saved by waiting, only by running it again. Interactive
 * transactions are therefore retried (with a short, growing pause) when SQLite reports busy, and only
 * then: any other error goes straight to the caller. Everything inside a transaction already has to be
 * safe to run twice, because the whole function is rolled back and re-run.
 */
export function withBusyRetry<T extends PrismaClient>(client: T, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): T {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === "$transaction") {
        const original = value as (...args: unknown[]) => Promise<unknown>;
        return async (arg: unknown, ...rest: unknown[]) => {
          // A batch ($transaction([a, b])) is a single write transaction that takes the lock up front.
          if (typeof arg !== "function") return original.call(target, arg, ...rest);
          for (let attempt = 1; ; attempt++) {
            try {
              return await original.call(target, arg, ...rest);
            } catch (error) {
              if (!isBusyError(error) || attempt >= BUSY_RETRIES) throw error;
              await sleep(20 * 2 ** (attempt - 1) + Math.random() * 20);
            }
          }
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export function createPrismaClient(databaseUrl: string): PrismaClient {
  const path = databaseUrl.replace(/^file:/, "");
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  return withBusyRetry(new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: databaseUrl, timeout: 5000 }) }));
}

/** Apply the SQLite pragmas. The adapter holds one connection, so once per client is enough. */
export async function applyPragmas(client: PrismaClient): Promise<void> {
  // journal_mode returns a row, so every pragma goes through $queryRawUnsafe.
  for (const pragma of SQLITE_PRAGMAS) await client.$queryRawUnsafe(pragma);
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; prismaReady?: Promise<void> };

/**
 * The shared client, created on first use (not at import, so build steps and scripts that load
 * .env later still work). Reused across hot reloads in development. The pragmas are queued first
 * on the single connection, so they run before any query issued afterwards.
 */
export function db(): PrismaClient {
  if (!globalForPrisma.prisma) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForPrisma.prisma = createPrismaClient(url);
    globalForPrisma.prismaReady = applyPragmas(globalForPrisma.prisma);
  }
  return globalForPrisma.prisma;
}

/** Close the shared client, if one was ever created (shutdown, and test cleanup). Creating one just to close it would race its own startup. */
export async function closeDb(): Promise<void> {
  const client = globalForPrisma.prisma;
  if (!client) return;
  await globalForPrisma.prismaReady?.catch(() => undefined);
  globalForPrisma.prisma = undefined;
  globalForPrisma.prismaReady = undefined;
  await client.$disconnect();
}

/** Resolves once the pragmas are applied. Await at process boot (web, worker, scripts). */
export function dbReady(): Promise<void> {
  db();
  return globalForPrisma.prismaReady!;
}
