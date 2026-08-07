import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ProductionMonitor } from "../src/deployment/production-monitor.js";
import { getProductionProjectStore } from "../src/store/postgres-project-store.js";
import { getProductionTaskStore } from "../src/store/postgres-task-store.js";

const MonitorRequestSchema = z.object({
  taskId: z.string().uuid(),
});

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function authorized(request: Request, expected: string): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

export async function POST(request: Request): Promise<Response> {
  const factoryToken = process.env.FACTORY_API_TOKEN;
  if (!factoryToken) return json({ error: "service_not_configured" }, 503);
  if (!authorized(request, factoryToken)) return json({ error: "unauthorized" }, 401);
  if (!process.env.DATABASE_URL) return json({ error: "database_not_configured" }, 503);
  if (!process.env.VERCEL_AUTOMATION_TOKEN || !process.env.VERCEL_TEAM_ID) {
    return json({ error: "monitoring_not_configured" }, 503);
  }

  let payload: z.infer<typeof MonitorRequestSchema>;
  try {
    payload = MonitorRequestSchema.parse(await request.json());
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  try {
    const monitor = new ProductionMonitor(
      getProductionTaskStore(),
      getProductionProjectStore(),
    );
    const result = await monitor.monitor(payload.taskId);
    return json({ ok: true, result });
  } catch {
    return json({ error: "monitoring_failed" }, 502);
  }
}
