import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createMissionPlan } from "../src/ai/planner.js";

const PlanRequestSchema = z.object({
  request: z.string().min(3).max(10_000),
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

  const supplied = authorization.slice("Bearer ".length);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);

  return suppliedBytes.length === expectedBytes.length
    && timingSafeEqual(suppliedBytes, expectedBytes);
}

export async function POST(request: Request): Promise<Response> {
  const factoryToken = process.env.FACTORY_API_TOKEN;
  if (!factoryToken) {
    return json({ error: "service_not_configured" }, 503);
  }

  if (!hasValidBearer(request, factoryToken)) {
    return json({ error: "unauthorized" }, 401);
  }

  let payload: z.infer<typeof PlanRequestSchema>;
  try {
    payload = PlanRequestSchema.parse(await request.json());
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  try {
    const plan = await createMissionPlan(payload.request);
    return json({ ok: true, plan });
  } catch {
    return json({ error: "planning_failed" }, 502);
  }
}
