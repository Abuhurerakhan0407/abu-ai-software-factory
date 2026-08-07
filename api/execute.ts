import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  ExecutionError,
  MissionExecutor,
} from "../src/mission-control/executor.js";
import { getProductionAgentRunStore } from "../src/store/postgres-agent-run-store.js";
import { getProductionTaskStore } from "../src/store/postgres-task-store.js";

const ExecuteRequestSchema = z.object({
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
  if (!process.env.OPENROUTER_API_KEY) return json({ error: "worker_not_configured" }, 503);

  let payload: z.infer<typeof ExecuteRequestSchema>;
  try {
    payload = ExecuteRequestSchema.parse(await request.json());
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  try {
    const executor = new MissionExecutor(
      getProductionTaskStore(),
      getProductionAgentRunStore(),
    );
    const mission = await executor.execute(payload.taskId);
    return json({ ok: true, mission });
  } catch (error) {
    if (error instanceof ExecutionError) {
      const status = error.code === "task_not_found" ? 404 : 409;
      return json({ error: error.code }, status);
    }
    return json({ error: "execution_failed" }, 502);
  }
}
