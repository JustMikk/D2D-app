import { z } from "zod";
import { validationFailed } from "@/lib/api/errors";
import { json, route } from "@/lib/api/route";
import { LIMITS } from "@/lib/api/rateLimit";
import { intakeProspect } from "@/lib/services/intake";

// POST /api/v1/intake/prospects (PRD INT-1): API key with intake:write, 120 requests a minute per key.
// accepted → 201; duplicate, merged, do_not_knock → 200; invalid → 400 with field details.
export const POST = route({ access: { apiScope: "intake:write" }, body: z.unknown(), limit: LIMITS.intake }, async ({ body, apiKey }) => {
  const outcome = await intakeProspect(body, { type: "API_KEY", keyId: apiKey!.id });
  switch (outcome.status) {
    case "invalid":
      throw validationFailed(outcome.errors, "The prospect is missing required fields or has invalid values.");
    case "accepted":
      return json({ status: "accepted", doorId: outcome.doorId }, 201);
    case "do_not_knock":
      return { status: "do_not_knock" };
    default:
      return { status: outcome.status, doorId: outcome.doorId };
  }
});
