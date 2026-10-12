import { route } from "@/lib/api/route";
import { CrmIdsUpdate, updateCrmIds } from "@/lib/services/crm";

// PATCH /api/v1/integrations/crm-ids: API key with crm:write. Returns a status per item.
export const PATCH = route({ access: { apiScope: "crm:write" }, body: CrmIdsUpdate }, async ({ body, apiKey }) =>
  updateCrmIds({ type: "API_KEY", keyId: apiKey!.id }, body),
);
