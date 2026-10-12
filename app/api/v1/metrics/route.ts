import { route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { getMetrics, metricsCsv, MetricsQuery } from "@/lib/services/metrics";

// GET /api/v1/metrics?from=&to=&repId=&format=json|csv (PRD MGR-8). Viewers may read.
export const GET = route({ access: { roles: MANAGER_ROLES, viewerReads: true }, query: MetricsQuery }, async ({ query }) => {
  const metrics = await getMetrics(query);
  if (query.format === "csv") {
    return new Response(metricsCsv(metrics), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="canvass-metrics-${query.from}-to-${query.to}.csv"` } });
  }
  return metrics;
});
