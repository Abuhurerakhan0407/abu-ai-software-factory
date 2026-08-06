import { afterEach, describe, expect, it } from "vitest";
import { GET, POST } from "../api/tasks.js";

const token = "correct-secret-token-for-testing";
const originalToken = process.env.FACTORY_API_TOKEN;
const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalToken === undefined) delete process.env.FACTORY_API_TOKEN;
  else process.env.FACTORY_API_TOKEN = originalToken;

  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("task API", () => {
  it("fails closed without the factory token", async () => {
    delete process.env.FACTORY_API_TOKEN;
    delete process.env.DATABASE_URL;
    const response = await GET(new Request("https://factory.test/api/tasks"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "service_not_configured" });
  });

  it("rejects invalid authorization", async () => {
    process.env.FACTORY_API_TOKEN = token;
    delete process.env.DATABASE_URL;
    const response = await GET(new Request("https://factory.test/api/tasks", {
      headers: { authorization: "Bearer wrong" },
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("fails closed when database configuration is absent", async () => {
    process.env.FACTORY_API_TOKEN = token;
    delete process.env.DATABASE_URL;
    const response = await GET(new Request("https://factory.test/api/tasks", {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "database_not_configured" });
  });

  it("validates task payloads before touching the database", async () => {
    process.env.FACTORY_API_TOKEN = token;
    process.env.DATABASE_URL = "postgresql://unused.invalid/postgres";
    const response = await POST(new Request("https://factory.test/api/tasks", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "x" }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });
});

