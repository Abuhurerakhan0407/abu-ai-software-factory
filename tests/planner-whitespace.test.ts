import { describe, expect, it } from "vitest";
import { parseMissionPlanJson } from "../src/mission-control/planner.js";

describe("parseMissionPlanJson whitespace handling", () => {
  const payload = {
    summary: "A mission plan",
    category: "feature",
    actions: [{
      id: "1-action",
      kind: "modify_code",
      summary: "Modify a file",
      target: "test.ts",
      reversible: true,
    }],
    requiresHuman: false,
  };

  it("accepts valid JSON with leading and trailing whitespace", () => {
    const whitespaceJson = `
${JSON.stringify(payload)}
`;
    expect(parseMissionPlanJson(whitespaceJson)).toEqual(payload);
  });

  it("accepts JSON wrapped in Markdown code fences with whitespace", () => {
    const fencedWithWhitespace = `
\n```json\n${JSON.stringify(payload)}\n```\n
`;
    expect(parseMissionPlanJson(fencedWithWhitespace)).toEqual(payload);
  });
});