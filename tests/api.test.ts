import { afterEach, describe, expect, it } from "vitest";
import { GET as health } from "../api/health.js";
import { POST as plan } from "../api/plan.js";

const originalFactoryToken = process.env.FACTORY_API_TOKEN;

afterEach(() => {
  if (originalFactoryToken === undefined) {
    delete process.env.FACTORY_API_TOKEN;
  } else {
    process.env.FACTORY_API_TOKEN = originalFactoryToken;
  }
});

describe("factory API", () => {
  it("reports health without exposing secrets", async () => {
    process.env.DATABASE_URL = "postgres://health-secret";
    process.env.FACTORY_API_TOKEN = "factory-health-secret";
    process.env.OPENROUTER_API_KEY = "openrouter-health-secret";
    process.env.GITHUB_CONNECTOR_ID = "github-health-secret";

    const response = health();
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      ok: true,
      service: "abu-ai-software-factory",
      status: "ready",
      checks: { coreRuntime: true },
    });
    expect(serialized).not.toContain("health-secret");
  });

  it("fails closed when the factory API token is missing", async () => {
    delete process.env.FACTORY_API_TOKEN;
    const response = await plan(new Request("https://factory.test/api/plan", {
      method: "POST",
      body: JSON.stringify({ request: "Build attendance export" }),
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "service_not_configured" });
  });

  it("rejects an invalid bearer token", async () => {
    process.env.FACTORY_API_TOKEN = "correct-secret-token-for-testing";
    const response = await plan(new Request("https://factory.test/api/plan", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
      body: JSON.stringify({ request: "Build attendance export" }),
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects malformed authorized requests without calling AI", async () => {
    process.env.FACTORY_API_TOKEN = "correct-secret-token-for-testing";
    const response = await plan(new Request("https://factory.test/api/plan", {
      method: "POST",
      headers: {
        authorization: "Bearer correct-secret-token-for-testing",
        "content-type": "application/json",
      },
      body: JSON.stringify({ request: "x" }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });
});
