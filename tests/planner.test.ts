import { describe, expect, it, vi } from "vitest";
import {
  applyDeterministicExactContent,
  normalizePlannerCategory,
  parseMissionPlanJson,
  PlannerTimeoutError,
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

describe("applyDeterministicExactContent", () => {
  it("clears model-invented content when request is not exact", () => {
    const sanitized = applyDeterministicExactContent(
      "Create one focused test file without modifying existing files.",
      plan([{
        kind: "modify_code",
        summary: "Create generated test file",
        target: "tests/planner-whitespace.test.ts",
        expectedContent: "invented invalid source",
        reversible: true,
      }]),
    );

    expect(sanitized.actions[0]?.expectedContent).toBeNull();
  });

  it("keeps publication instructions out of unquoted exact content", () => {
    const sanitized = applyDeterministicExactContent(
      "Create docs/autopilot-agent-smoke.md containing exactly: Autopilot coding-agent smoke test passed. Publish changes only through a draft pull request.",
      plan([{
        kind: "modify_code",
        summary: "Create documentation smoke-test file",
        target: "docs/autopilot-agent-smoke.md",
        expectedContent: "Autopilot coding-agent smoke test passed. Publish changes only through a draft pull request.",
        reversible: true,
      }]),
    );

    expect(sanitized.actions[0]?.expectedContent).toBe(
      "Autopilot coding-agent smoke test passed.",
    );
  });

  it("keeps safety guardrails out of unquoted exact content", () => {
    const sanitized = applyDeterministicExactContent(
      "Create docs/autopilot-agent-smoke.md containing exactly: Autopilot coding-agent smoke test passed. Do not modify application code, database, deployments, configuration, or secrets.",
      plan([{
        kind: "modify_code",
        summary: "Create documentation smoke-test file",
        target: "docs/autopilot-agent-smoke.md",
        expectedContent: "wrong model extraction",
        reversible: true,
      }]),
    );

    expect(sanitized.actions[0]?.expectedContent).toBe(
      "Autopilot coding-agent smoke test passed.",
    );
  });

  it("honors quoted exact content verbatim", () => {
    const sanitized = applyDeterministicExactContent(
      'Create docs/example.md. Entire file content must be exactly "Publish changes carefully. Do not modify this sentence." Publication requirement: draft pull request only.',
      plan([{
        kind: "modify_code",
        summary: "Create exact documentation file",
        target: "docs/example.md",
        expectedContent: "wrong model extraction",
        reversible: true,
      }]),
    );

    expect(sanitized.actions[0]?.expectedContent).toBe(
      "Publish changes carefully. Do not modify this sentence.",
    );
  });

  it("does not guess which file owns exact content when multiple files change", () => {
    const original = plan([
      {
        kind: "modify_code",
        summary: "Create first file",
        target: "docs/one.md",
        expectedContent: null,
        reversible: true,
      },
      {
        kind: "modify_code",
        summary: "Create second file",
        target: "docs/two.md",
        expectedContent: null,
        reversible: true,
      },
    ]);

    expect(applyDeterministicExactContent(
      "Create docs/one.md containing exactly: hello",
      original,
    )).toEqual(original);
  });
});

describe("normalizePlannerCategory", () => {
  it("maps testing output to the supported feature category", () => {
    expect(normalizePlannerCategory("testing")).toBe("feature");
  });

  it("maps authentication output to security", () => {
    expect(normalizePlannerCategory("authentication")).toBe("security");
  });

  it("fails unknown categories into other", () => {
    expect(normalizePlannerCategory("unexpected-provider-label")).toBe("other");
  });
});

describe("parseMissionPlanJson", () => {
  const expected = {
    summary: "Analyze repository architecture",
    category: "docs",
    actions: [{
      kind: "analyze",
      summary: "Analyze README architecture",
      expectedContent: null,
      target: "README.md",
      reversible: false,
    }],
  };

  it("parses a raw JSON plan", () => {
    expect(parseMissionPlanJson(JSON.stringify(expected))).toEqual(expected);
  });

  it("normalizes an unsupported model category before validation", () => {
    const output = JSON.stringify({ ...expected, category: "testing" });

    expect(parseMissionPlanJson(output).category).toBe("feature");
  });

  it("accepts one Markdown JSON fence from free models", () => {
    const fence = String.fromCharCode(96).repeat(3);
    const output = fence + "json\n" + JSON.stringify(expected) + "\n" + fence;

    expect(parseMissionPlanJson(output)).toEqual(expected);
  });

  it("rejects prose around a JSON object", () => {
    expect(() => parseMissionPlanJson(
      "Here is the plan: " + JSON.stringify(expected),
    )).toThrow();
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

  it("does not retry a timed-out model call", async () => {
    const operation = vi.fn().mockRejectedValue(new PlannerTimeoutError(30_000));

    await expect(retryPlannerOperation(operation)).rejects.toThrow(
      "Planner model call timed out after 30000ms",
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the provider quota is exhausted", async () => {
    const rateLimit = Object.assign(
      new Error("429 Rate limit exceeded: free-models-per-day"),
      { status: 429, code: 429 },
    );
    const operation = vi.fn().mockRejectedValue(rateLimit);

    await expect(retryPlannerOperation(operation)).rejects.toBe(rateLimit);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("fails closed after the bounded retry budget is exhausted", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("planner unavailable"));

    await expect(retryPlannerOperation(operation, 3)).rejects.toThrow("planner unavailable");
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
