// Two processes (web and worker) share one SQLite file. A transaction that reads, and then writes after another
// connection has committed, is refused at once by SQLite (SQLITE_BUSY_SNAPSHOT): the busy timeout does not
// apply. lib/db retries such transactions, so the web app never answers a request with a 500 for it.
import { describe, expect, it } from "vitest";
import { applyPragmas, createPrismaClient } from "@/lib/db";

const url = () => process.env.DATABASE_URL!;

async function twoConnections() {
  const a = createPrismaClient(url());
  const b = createPrismaClient(url());
  await Promise.all([applyPragmas(a), applyPragmas(b)]);
  return { a, b };
}

describe("write contention between processes", () => {
  it("a read-then-write transaction overtaken by another connection is retried and succeeds", async () => {
    const { a, b } = await twoConnections();
    let attempts = 0;
    await a.$transaction(async (tx) => {
      attempts++;
      await tx.appSetting.findMany(); // takes the read snapshot
      if (attempts === 1) await b.appSetting.create({ data: { key: `other-${Math.random()}`, value: "1" } }); // the other process commits
      await tx.appSetting.create({ data: { key: `mine-${Math.random()}`, value: "1" } }); // the upgrade that SQLite refuses
    });
    expect(attempts).toBe(2);
    await Promise.all([a.$disconnect(), b.$disconnect()]);
  });

  it("gives up after repeated conflicts and reports the error", async () => {
    const { a, b } = await twoConnections();
    let attempts = 0;
    await expect(
      a.$transaction(async (tx) => {
        attempts++;
        await tx.appSetting.findMany();
        await b.appSetting.create({ data: { key: `always-${Math.random()}`, value: "1" } }); // overtaken every time
        await tx.appSetting.create({ data: { key: `never-${Math.random()}`, value: "1" } });
      }),
    ).rejects.toBeTruthy();
    expect(attempts).toBeGreaterThan(2);
    expect(attempts).toBeLessThanOrEqual(8);
    await Promise.all([a.$disconnect(), b.$disconnect()]);
  });

  it("does not retry an ordinary failure, and leaves the rest of the transaction rolled back", async () => {
    const { a, b } = await twoConnections();
    let attempts = 0;
    await expect(
      a.$transaction(async (tx) => {
        attempts++;
        await tx.appSetting.create({ data: { key: "rolled-back", value: "1" } });
        throw new Error("a bug in the caller");
      }),
    ).rejects.toThrow("a bug in the caller");
    expect(attempts).toBe(1);
    expect(await b.appSetting.count({ where: { key: "rolled-back" } })).toBe(0);
    await Promise.all([a.$disconnect(), b.$disconnect()]);
  });

  it("batch transactions and plain queries pass straight through", async () => {
    const { a, b } = await twoConnections();
    const [x, y] = await a.$transaction([a.appSetting.create({ data: { key: "batch-1", value: "1" } }), a.appSetting.create({ data: { key: "batch-2", value: "2" } })]);
    expect([x.key, y.key]).toEqual(["batch-1", "batch-2"]);
    expect(await b.appSetting.count({ where: { key: { startsWith: "batch-" } } })).toBe(2);
    await Promise.all([a.$disconnect(), b.$disconnect()]);
  });
});
