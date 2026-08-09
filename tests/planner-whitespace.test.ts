import { describe, expect, it } from "vitest";
import { parseMissionPlanJson } from "../src/agents/planner.js";

describe("parseMissionPlanJson whitespace handling", () => {
  const validPlan = {
    summary: "Test plan",
    category: "docs",
    actions: [{
      id: "1-test",
      kind: "modify_code",
      summary: "Test action",
      target: "test.md",
      reversible: true,
    }],
    requiresHuman: false,
  };

  it("accepts JSON with leading and trailing whitespace", () => {
    const input = `\n${JSON.stringify(validPlan)}\n`;
    expect(parseMissionPlanJson(input)).toEqual(validPlan);
  });

  it("accepts JSON with multiple newlines and spaces", () => {
    const input = `\n\n  ${JSON.stringify(validPlan)}  \n\n`;
    expect(parseMissionPlanJson(input)).toEqual(validPlan);
  });

  it("accepts JSON with Markdown code fences and whitespace", () => {
    const input = `\n\n\`\`\`json\n${JSON.stringify(validPlan)}\n\`\`\`\n\n`;
    expect(parseMissionPlanJson(input)).toEqual(validPlan);
  });
});