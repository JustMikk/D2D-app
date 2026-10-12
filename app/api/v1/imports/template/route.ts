import { route } from "@/lib/api/route";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { csvTemplate } from "@/lib/domain/importFile";

// GET /api/v1/imports/template: the CSV layout, with one example row.
export const GET = route({ access: { roles: ADMIN_ROLES } }, async () => new Response(csvTemplate(), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="canvass-import-template.csv"' } }));
