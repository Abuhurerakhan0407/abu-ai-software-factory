import { describe, expect, it } from "vitest";
import { parseMissionPlanJson } from "../src/ai/planner.js";

describe("parseMissionPlanJson whitespace handling", () => {
  it("accepts valid JSON surrounded by whitespace", () => {
    const validPlan = {
      summary: "Test plan",
      category: "feature",
      actions: [{
        kind: "modify_code",
        summary: "Edit a file",
        expectedContent: null,
        target: "test.txt",
        reversible: true,
      }],
    };
    const input = `  \n${JSON.stringify(validPlan)}\n  `;

    expect(parseMissionPlanJson(input)).toEqual(validPlan);
  });
});
