import { describe, expect, it } from "vitest";
import { parseMissionPlanJson } from "../src/ai/planner.js";

describe("parseMissionPlanJson whitespace handling", () => {
  const validPlan = {
    summary: "Test plan",
    category: "feature",
    actions: [
      {
        kind: "modify_code",
        summary: "Edit a file",
        expectedContent: null,
        target: "test.txt",
        reversible: true,
      },
    ],
  };

  it("accepts a plain JSON string without whitespace", () => {
    const json = JSON.stringify(validPlan);
    expect(parseMissionPlanJson(json)).toEqual(validPlan);
  });

  it("accepts a JSON string with surrounding whitespace", () => {
    const json = `  \n${JSON.stringify(validPlan)}\n  `;
    expect(parseMissionPlanJson(json)).toEqual(validPlan);
  });

  it("accepts JSON inside markdown fences", () => {
    const json = `\x60\x60\x60json\n${JSON.stringify(validPlan)}\n\x60\x60\x60`;
    expect(parseMissionPlanJson(json)).toEqual(validPlan);
  });

  it("accepts JSON inside markdown fences with surrounding whitespace", () => {
    const json = `\n\n\x60\x60\x60\n${JSON.stringify(validPlan)}\n\x60\x60\x60\n\n`;
    expect(parseMissionPlanJson(json)).toEqual(validPlan);
  });

  it("accepts JSON inside markdown fences without the 'json' language identifier", () => {
    const json = `\x60\x60\x60\n${JSON.stringify(validPlan)}\n\x60\x60\x60`;
    expect(parseMissionPlanJson(json)).toEqual(validPlan);
  });
});