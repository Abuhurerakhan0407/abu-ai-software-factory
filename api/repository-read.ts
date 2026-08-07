import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  RepositoryReadError,
  RepositoryReadInputSchema,
  SafeRepositoryReader,
} from "../src/github/safe-repository-reader.js";
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
  if (!hasValidBearer(request, factoryToken)) {
    return json({ error: "unauthorized" }, 401);
  }
  return undefined;
}

export async function POST(request: Request): Promise<Response> {
  const denied = authorize(request);
  if (denied) return denied;

  if (!process.env.DATABASE_URL) {
    return json({ error: "database_not_configured" }, 503);
  }
  if (!process.env.GITHUB_CONNECTOR_ID || !process.env.VERCEL_OIDC_TOKEN) {
    return json({ error: "github_not_configured" }, 503);
  }

  let input: z.infer<typeof RepositoryReadInputSchema>;
  try {
    input = RepositoryReadInputSchema.parse(await request.json());
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  try {
    const result = await new SafeRepositoryReader(
      getProductionProjectStore(),
    ).read(input);
    return json({ ok: true, file: result });
  } catch (error) {
    if (error instanceof RepositoryReadError) {
      const status = error.code === "project_not_found"
        ? 404
        : error.code === "project_inactive"
          ? 409
          : error.code === "content_too_large"
            ? 413
            : 400;
      return json({ error: error.code }, status);
    }
    return json({ error: "github_read_failed" }, 502);
  }
}
