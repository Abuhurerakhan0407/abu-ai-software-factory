import { describe, expect, it, vi } from "vitest";
import {
  retryPlannerOperation,
  sanitizeMissionPlan,
  type MissionPlan,
} from "../src/ai/planner.js";

function plan(actions: MissionPlan["actions"]): MissionPlan {
  return {
    summary: "Run only the requested work",
    category: "security",
    actions,
  };
}

describe("sanitizeMissionPlan", () => {
  it("drops negated no-op actions before policy evaluation", () => {
    const sanitized = sanitizeMissionPlan(plan([
      {
        kind: "run_tests",
        summary: "Run existing automated tests",
        target: "test suite",
        reversible: true,
      },
      {
        kind: "change_billing",
        summary: "No billing changes required.",
        target: "billing system",
        reversible: true,
      },
      {
        kind: "access_raw_secret",
        summary: "No secret access required.",
        target: "secrets manager",
        reversible: true,
      },
    ]));

    expect(sanitized.actions.map((action) => action.kind)).toEqual(["run_tests"]);
  });

  it("keeps genuinely requested blocked actions fail-closed", () => {
    const sanitized = sanitizeMissionPlan(plan([
      {
        kind: "access_raw_secret",
        summary: "Read a raw production secret",
        target: "production secret",
        reversible: false,
      },
    ]));

    expect(sanitized.actions[0]?.kind).toBe("access_raw_secret");
  });

  it("rejects database actions that target repository files", () => {
    expect(() => sanitizeMissionPlan(plan([
      {
        kind: "write_production_db",
        summary: "Create documentation smoke-test file",
        target: "docs/autopilot-agent-smoke.md",
        reversible: true,
      },
    ]))).toThrow("repository file changes must use modify_code");
  });

  it("keeps repository file changes classified as modify_code", () => {
    const sanitized = sanitizeMissionPlan(plan([
      {
        kind: "modify_code",
        summary: "Create documentation smoke-test file",
        target: "docs/autopilot-agent-smoke.md",
        reversible: true,
      },
    ]));

    expect(sanitized.actions[0]?.kind).toBe("modify_code");
  });

  it("rejects plans containing only no-op actions", () => {
    expect(() => sanitizeMissionPlan(plan([
      {
        kind: "change_billing",
        summary: "No billing change is needed.",
        target: "billing system",
        reversible: true,
      },
    ]))).toThrow("Planner returned no executable actions");
  });
});

describe("retryPlannerOperation", () => {
  it("returns immediately when the first planner attempt succeeds", async () => {
    const operation = vi.fn().mockResolvedValue("valid plan");

    await expect(retryPlannerOperation(operation)).resolves.toBe("valid plan");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries transient or invalid planner output and then succeeds", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("invalid structured output"))
      .mockResolvedValueOnce("valid plan");

    await expect(retryPlannerOperation(operation)).resolves.toBe("valid plan");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("fails closed after the bounded retry budget is exhausted", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("planner unavailable"));

    await expect(retryPlannerOperation(operation, 3)).rejects.toThrow("planner unavailable");
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
