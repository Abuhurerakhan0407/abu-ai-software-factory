import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  createMissionPlan,
  isPlannerQuotaError,
} from "../src/ai/planner.js";

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

function redactDiagnostic(value: string): string {
  let redacted = value;
  const configuredSecrets = [
    process.env.FACTORY_API_TOKEN,
    process.env.OPENROUTER_API_KEY,
  ].filter((secret): secret is string => Boolean(secret && secret.length >= 4));

  for (const secret of configuredSecrets) {
    redacted = redacted.split(secret).join("[redacted]");
  }

  return redacted
    .replace(/Bearer\s+[^\s"'\\]+/gi, "Bearer [redacted]")
    .replace(/\bsk-(?:or-v1-)?[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .slice(0, 1_000);
}

function diagnosticField(
  error: unknown,
  key: "status" | "code" | "type",
): string | number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>)[key];

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.length <= 200) {
    return redactDiagnostic(value);
  }

  return undefined;
}

export function plannerErrorDiagnostic(error: unknown): {
  name: string;
  message: string;
  status?: string | number;
  code?: string | number;
  type?: string | number;
} {
  const record = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : undefined;
  const name = error instanceof Error
    ? error.name
    : typeof record?.name === "string"
      ? redactDiagnostic(record.name)
      : "UnknownError";
  const message = error instanceof Error
    ? redactDiagnostic(error.message)
    : typeof record?.message === "string"
      ? redactDiagnostic(record.message)
      : "Unknown planning error";

  const diagnostic = { name, message } as {
    name: string;
    message: string;
    status?: string | number;
    code?: string | number;
    type?: string | number;
  };

  for (const key of ["status", "code", "type"] as const) {
    const value = diagnosticField(error, key);
    if (value !== undefined) {
      diagnostic[key] = value;
    }
  }

  return diagnostic;
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
  } catch (error) {
    const diagnostic = plannerErrorDiagnostic(error);
    const quotaExhausted = isPlannerQuotaError(error);
    console.error(
      quotaExhausted ? "planning_rate_limited" : "planning_failed",
      diagnostic,
    );
    return json(
      {
        error: quotaExhausted ? "planning_rate_limited" : "planning_failed",
        diagnostic,
      },
      quotaExhausted ? 429 : 502,
    );
  }
}
