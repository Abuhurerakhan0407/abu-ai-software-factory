import { timingSafeEqual } from "node:crypto";
import { TaskInputSchema } from "../src/contracts/task.js";
import { MissionControl } from "../src/mission-control/mission-control.js";
import { getProductionTaskStore } from "../src/store/postgres-task-store.js";

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

export async function GET(request: Request): Promise<Response> {
  const denied = authorize(request);
  if (denied) return denied;
  if (!process.env.DATABASE_URL) return json({ error: "database_not_configured" }, 503);

  try {
    const tasks = await getProductionTaskStore().list();
    return json({ ok: true, tasks });
  } catch {
    return json({ error: "database_unavailable" }, 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = authorize(request);
  if (denied) return denied;
  if (!process.env.DATABASE_URL) return json({ error: "database_not_configured" }, 503);

  let input;
  try {
    input = TaskInputSchema.parse(await request.json());
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  try {
    const missionControl = new MissionControl(getProductionTaskStore());
    const task = await missionControl.intake(input);
    return json({ ok: true, task }, 201);
  } catch {
    return json({ error: "database_unavailable" }, 503);
  }
}

