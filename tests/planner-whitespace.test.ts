import { describe, expect, it } from "vitest";
import { parseMissionPlanJson } from "../src/ai/planner.js";

describe("parseMissionPlanJson whitespace handling", () => {
  const validPlan = {
    summary: "Test whitespace parsing",
    category: "feature",
    actions: [{
      kind: "modify_code",
      summary: "Create test file",
      expectedContent: "hello world",
      target: "tests/whitespace.ts",
      reversible: true,
    }],
  };

  it("accepts JSON with leading/trailing whitespace", () => {
    const input = `\n${JSON.stringify(validPlan)}\n`;
    expect(parseMissionPlanJson(input)).toEqual(validPlan);
  });

  it("accepts JSON inside Markdown code fences with whitespace", () => {
    const input = `\n\`\`\`json\n${JSON.stringify(validPlan)}\n\`\`\`\n`;
    expect(parseMissionPlanJson(input)).toEqual(validPlan);
  });

  it("accepts JSON inside Markdown code fences with extra spaces and newlines", () => {
    const input = `\n\`\`\`json\n\n${JSON.stringify(validPlan)}\n\n\`\`\`\n`;
    expect(parseMissionPlanJson(input)).toEqual(validPlan);
  });

  it("handles messy whitespace within markdown fences", () => {
    const input = `\`\`\`  json  \n${JSON.stringify(validPlan)}\n\`\`\``;
    expect(parseMissionPlanJson(input)).toEqual(validPlan);
  });
});