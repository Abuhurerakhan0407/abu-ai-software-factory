import { describe, expect, it } from "vitest";
import { parseMissionPlanJson } from "../src/planner/planner.js";

describe("parseMissionPlanJson whitespace handling", () => {
  const validPayload = {
    summary: "Test mission plan",
    category: "docs",
    actions: [{
      kind: "modify_code",
      summary: "Test action",
      target: "test.md",
      reversible: true,
    }],
    requiresHuman: false,
  };

  it("accepts JSON with leading/trailing whitespace", () => {
    const input = `\n\n${JSON.stringify(validPayload)}\n\n`;
    expect(parseMissionPlanJson(input)).toEqual(validPayload);
  });

  it("accepts JSON with extreme whitespace/newlines", () => {
    const input = `\n	
	${JSON.stringify(validPayload)}


`;
    expect(parseMissionPlanJson(input)).toEqual(validPayload);
  });
});
