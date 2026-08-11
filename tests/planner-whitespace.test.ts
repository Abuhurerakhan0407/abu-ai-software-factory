import { describe, expect, it } from "vitest";
import { parseMissionPlanJson } from "../src/ai/planner.js";

describe("parseMissionPlanJson whitespace handling", () => {
  const validPlan = {
    summary: "Plan with whitespace",
    category: "feature",
    actions: [{
      kind: "modify_code",
      summary: "Modify a file",
      expectedContent: "hello world",
      target: "test.txt",
      reversible: true,
    }],
  };

  it("accepts JSON with surrounding whitespace", () => {
    const input = `
      
      ${JSON.stringify(validPlan)}      
    `;
    expect(parseMissionPlanJson(input)).toEqual(validPlan);
  });

  it("accepts JSON inside Markdown fences with extra whitespace", () => {
    const input = `

\x60\x60\x60json

  ${JSON.stringify(validPlan)}  

\x60\x60\x60

`;
    expect(parseMissionPlanJson(input)).toEqual(validPlan);
  });

  it("accepts JSON in Markdown fences with whitespace after language identifier", () => {
    const input = `\x60\x60\x60json   
${JSON.stringify(validPlan)}
\x60\x60\x60`;
    expect(parseMissionPlanJson(input)).toEqual(validPlan);
  });

  it("handles empty whitespace input by throwing error", () => {
    expect(() => parseMissionPlanJson("   ")).toThrow();
  });
});