import { randomUUID, timingSafeEqual } from "node:crypto";
import { ProjectInputSchema, type ProjectRecord } from "../src/contracts/project.js";
import { getProductionProjectStore } from "../src/store/postgres-project-store.js";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
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
    const projects = await getProductionProjectStore().list();
    return json({ ok: true, projects });
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
    input = ProjectInputSchema.parse(await request.json());
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const now = new Date().toISOString();
  const project: ProjectRecord = {
    id: randomUUID(),
    name: input.name,
    repository: input.repository,
    status: "active",
    config: {
      ...(input.database ? { database: input.database } : {}),
      ...(input.deployment ? { deployment: input.deployment } : {}),
    },
    createdAt: now,
    updatedAt: now,
  };

  try {
    await getProductionProjectStore().upsert(project);
    return json({ ok: true, project }, 201);
  } catch {
    return json({ error: "database_unavailable" }, 503);
  }
}
