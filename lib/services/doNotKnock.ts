// The do-not-knock list (PRD INT-6): admins add a company or an address. Matching intake is rejected with
// `do_not_knock` (the intake pipeline already checks), and open doors that match close with that reason.
import { z } from "zod";
import { audit, userActor } from "@/lib/api/audit";
import { conflict, notFound, validationFailed } from "@/lib/api/errors";
import { db, type Db } from "@/lib/db";
import { companyKey, domainOf, streetKey, zip5 } from "@/lib/domain/normalize";
import { doorSnapshot, emit } from "@/lib/events";

const note = z.string().trim().max(300).optional();

export const DoNotKnockCreate = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("COMPANY"), company: z.string().trim().min(2, "Enter a company name or website"), note }),
  z.object({ kind: z.literal("ADDRESS"), street: z.string().trim().min(3, "Enter the street address"), zip: z.string().trim().min(5, "Enter a 5-digit ZIP"), note }),
]);
export type DoNotKnockCreate = z.infer<typeof DoNotKnockCreate>;

/** What is stored: a website's domain, else the normalized company name; or "streetKey|zip" for an address. */
export function ruleFor(input: DoNotKnockCreate): { kind: "COMPANY" | "ADDRESS"; value: string } {
  if (input.kind === "COMPANY") {
    const looksLikeSite = !/\s/.test(input.company) && input.company.includes(".");
    const domain = looksLikeSite ? domainOf(input.company) : null;
    const value = domain ?? companyKey(input.company);
    if (!value) throw validationFailed([{ path: "company", message: "Enter a company name or website" }]);
    return { kind: "COMPANY", value };
  }
  const key = streetKey(input.street);
  const zip = zip5(input.zip);
  if (!key || zip.length !== 5) throw validationFailed([{ path: "zip", message: "Enter the street address and a 5-digit ZIP" }]);
  return { kind: "ADDRESS", value: `${key}|${zip}` };
}

/** Close every open door the rule matches. Returns how many. */
export async function closeMatchingDoors(tx: Db, rule: { kind: "COMPANY" | "ADDRESS"; value: string }, actor: ReturnType<typeof userActor>, now: Date): Promise<number> {
  const [key, zip] = rule.kind === "ADDRESS" ? rule.value.split("|") : [];
  const doors = await tx.door.findMany({
    where: {
      status: { not: "CLOSED" },
      ...(rule.kind === "COMPANY" ? { company: { OR: [{ nameKey: rule.value }, { domain: rule.value }] } } : { streetKey: key, zip }),
    },
    select: { id: true },
  });
  for (const d of doors) {
    await tx.door.update({ where: { id: d.id }, data: { status: "CLOSED", closedReason: "DO_NOT_KNOCK", closedAt: now, reviewReason: null, reviewDetail: null } });
    await tx.assignment.updateMany({ where: { doorId: d.id, status: "ACTIVE" }, data: { status: "CANCELLED", reason: "Do not knock" } });
    await emit(tx, "door.upserted", { door: await doorSnapshot(tx, d.id) }, now);
    await audit(tx, actor, "door.closed", "DOOR", d.id, { reason: "DO_NOT_KNOCK", rule: rule.value });
  }
  return doors.length;
}

export async function addDoNotKnock(actorUserId: string, input: unknown, now = new Date()) {
  const parsed = DoNotKnockCreate.parse(input);
  const rule = ruleFor(parsed);
  return db().$transaction(async (tx) => {
    if (await tx.doNotKnock.findUnique({ where: { kind_value: rule } })) throw conflict("That is already on the list.");
    const entry = await tx.doNotKnock.create({ data: { ...rule, note: parsed.note || null } });
    const closedDoors = await closeMatchingDoors(tx, rule, userActor(actorUserId), now);
    await audit(tx, userActor(actorUserId), "do_not_knock.added", "SETTING", entry.id, { ...rule, closedDoors });
    return { id: entry.id, ...rule, closedDoors };
  });
}

export async function listDoNotKnock() {
  const rows = await db().doNotKnock.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as "COMPANY" | "ADDRESS",
    value: r.value,
    // The address form is stored as "streetKey|zip": show it readably.
    label: r.kind === "ADDRESS" ? r.value.replace("|", ", ") : r.value,
    note: r.note,
    createdAt: r.createdAt,
  }));
}

/** Removing a rule lets new prospects in again. Doors already closed by it stay closed. */
export async function removeDoNotKnock(actorUserId: string, id: string) {
  const row = await db().doNotKnock.findUnique({ where: { id } });
  if (!row) throw notFound("That entry");
  await db().$transaction(async (tx) => {
    await tx.doNotKnock.delete({ where: { id } });
    await audit(tx, userActor(actorUserId), "do_not_knock.removed", "SETTING", id, { kind: row.kind, value: row.value });
  });
  return { id };
}
