// Twenty IDs written back by n8n (PRD NTF-5, backend spec §9.4), so later events carry crmId and the
// CRM upserts become direct.
import { z } from "zod";
import { audit, type Actor } from "@/lib/api/audit";
import { db } from "@/lib/db";

export const CrmIdsUpdate = z.object({
  items: z
    .array(z.object({ entityType: z.enum(["COMPANY", "DOOR", "REP"]), id: z.string().min(1), crmId: z.string().min(1).max(100) }))
    .min(1)
    .max(500),
});

type ItemResult = { entityType: string; id: string; status: "updated" | "unchanged" | "not_found" | "conflict" };

/** Each item is applied on its own: one bad ID does not reject the batch. */
export async function updateCrmIds(actor: Actor, input: unknown): Promise<{ results: ItemResult[] }> {
  const { items } = CrmIdsUpdate.parse(input);
  const results: ItemResult[] = [];
  for (const item of items) {
    const base = { entityType: item.entityType, id: item.id };
    const model = item.entityType === "COMPANY" ? db().company : item.entityType === "DOOR" ? db().door : db().rep;
    // The three delegates share findUnique/update shapes for these fields.
    const delegate = model as unknown as {
      findUnique(a: { where: { id: string }; select: { crmId: true } }): Promise<{ crmId: string | null } | null>;
      findFirst(a: { where: { crmId: string; NOT: { id: string } }; select: { id: true } }): Promise<{ id: string } | null>;
      update(a: { where: { id: string }; data: { crmId: string } }): Promise<unknown>;
    };
    const current = await delegate.findUnique({ where: { id: item.id }, select: { crmId: true } });
    if (!current) {
      results.push({ ...base, status: "not_found" });
      continue;
    }
    if (current.crmId === item.crmId) {
      results.push({ ...base, status: "unchanged" });
      continue;
    }
    if (await delegate.findFirst({ where: { crmId: item.crmId, NOT: { id: item.id } }, select: { id: true } })) {
      results.push({ ...base, status: "conflict" });
      continue;
    }
    await delegate.update({ where: { id: item.id }, data: { crmId: item.crmId } });
    await audit(db(), actor, "crm_id.updated", item.entityType, item.id, { before: current.crmId, after: item.crmId });
    results.push({ ...base, status: "updated" });
  }
  return { results };
}
