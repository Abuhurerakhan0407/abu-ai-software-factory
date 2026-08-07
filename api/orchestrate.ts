import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  MissionOrchestrator,
  OrchestrationError,
} from "../src/mission-control/orchestrator.js";
import { getProductionTaskStore } from "../src/store/postgres-task-store.js";

const OrchestrateRequestSchema = z.object({
  taskId: z.string().uuid(),
});

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

function hasValidBearer(request: Request, expected: string): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;

  const suppliedBytes = Buffer.from(authorization.slice("Bearer ".length));
  const expectedBytes = Buffer.from(expected);

  return suppliedBytes.length === expectedBytes.length
    && timingSafeEqual(suppliedBytes, expectedBytes);
}

function authorize(request: Request): Response | undefined {
  const factoryToken = process.env.FACTORY_API_TOKEN;
  if (!factoryToken) return json({ error: "service_not_configured" }, 503);
  if (!hasValidBearer(request, factoryToken)) return json({ error: "unauthorized" }, 401);
  return undefined;
}

export async function POST(request: Request): Promise<Response> {
  const denied = authorize(request);
  if (denied) return denied;
  if (!process.env.DATABASE_URL) return json({ error: "database_not_configured" }, 503);
  if (!process.env.OPENROUTER_API_KEY) return json({ error: "planner_not_configured" }, 503);

  let payload: z.infer<typeof OrchestrateRequestSchema>;
  try {
    payload = OrchestrateRequestSchema.parse(await request.json());
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  try {
    const orchestrator = new MissionOrchestrator(getProductionTaskStore());
    const mission = await orchestrator.prepare(payload.taskId);
    return json({ ok: true, mission });
  } catch (error) {
    if (error instanceof OrchestrationError) {
      const status = error.code === "task_not_found" ? 404 : 409;
      return json({ error: error.code }, status);
    }
    return json({ error: "orchestration_failed" }, 502);
  }
}
