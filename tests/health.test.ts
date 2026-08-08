import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "../api/health.js";

const ENV_KEYS = [
  "DATABASE_URL",
  "FACTORY_API_TOKEN",
  "OPENROUTER_API_KEY",
  "GITHUB_CONNECTOR_ID",
  "FACTORY_APPROVAL_TOKEN",
  "VERCEL_AUTOMATION_TOKEN",
  "VERCEL_TEAM_ID",
  "MISSION_CONTROL_MODEL",
] as const;

const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

function configureCore(): void {
  process.env.DATABASE_URL = "postgres://configured";
  process.env.FACTORY_API_TOKEN = "configured";
  process.env.OPENROUTER_API_KEY = "configured";
  process.env.GITHUB_CONNECTOR_ID = "configured";
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("GET /api/health", () => {
  it("fails readiness when core runtime configuration is missing", async () => {
    const response = GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.status).toBe("degraded");
    expect(body.checks.coreRuntime).toBe(false);
  });

  it("separates core readiness from production readiness", async () => {
    configureCore();

    const response = GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.productionReady).toBe(false);
    expect(body.checks).toEqual({
      coreRuntime: true,
      productionApproval: false,
      productionMonitoring: false,
      explicitAiModel: false,
    });
  });

  it("reports production readiness without exposing configured values", async () => {
    configureCore();
    process.env.FACTORY_APPROVAL_TOKEN = "approval-secret";
    process.env.VERCEL_AUTOMATION_TOKEN = "vercel-secret";
    process.env.VERCEL_TEAM_ID = "team-secret";
    process.env.MISSION_CONTROL_MODEL = "provider/model";

    const response = GET();
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(body.productionReady).toBe(true);
    expect(body.checks).toEqual({
      coreRuntime: true,
      productionApproval: true,
      productionMonitoring: true,
      explicitAiModel: true,
    });
    expect(serialized).not.toContain("approval-secret");
    expect(serialized).not.toContain("vercel-secret");
    expect(serialized).not.toContain("team-secret");
    expect(serialized).not.toContain("provider/model");
  });
});
