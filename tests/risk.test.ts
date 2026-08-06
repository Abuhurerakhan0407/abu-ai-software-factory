import { describe, expect, it } from "vitest";
import { gateForAction, riskForAction } from "../src/policy/risk.js";
import type { PlannedAction } from "../src/contracts/task.js";

function action(kind: PlannedAction["kind"]): PlannedAction {
  return { id: kind, kind, summary: "Test action", target: "test", reversible: true };
}

describe("risk policy", () => {
  it("auto-allows ordinary code work", () => {
    expect(riskForAction(action("modify_code"))).toBe("medium");
    expect(gateForAction(action("modify_code"))).toBe("auto_allowed");
  });

  it("requires approval before production deployment", () => {
    expect(gateForAction(action("deploy_production"))).toBe("approval_required");
  });

  it("blocks raw secret access", () => {
    expect(riskForAction(action("access_raw_secret"))).toBe("critical");
    expect(gateForAction(action("access_raw_secret"))).toBe("blocked");
  });
});
