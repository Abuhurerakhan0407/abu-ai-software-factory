import { describe, expect, it } from "vitest";
import {
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
