import { route } from "@/lib/api/route";
import { REP_ROLES } from "@/lib/auth/permissions";

// GET /api/v1/push/vapid-public-key: null when push is not configured (the app then polls).
export const GET = route({ access: { roles: REP_ROLES } }, async () => ({ publicKey: process.env.VAPID_PUBLIC_KEY || null }));
