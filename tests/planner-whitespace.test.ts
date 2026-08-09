import { describe, expect, it } from "vitest";
import { parseMissionPlanJson } from "../src/mission-control/planner.js";

describe("parseMissionPlanJson whitespace handling", () => {
  const validPayload = {
    summary: "Test mission plan",
    category: "feature",
    actions: [{
      id: "1-action",
      kind: "modify_code",
      summary: "Action summary",
      target: "test.ts",
      reversible: true,
    }],
  };

  const jsonString = JSON.stringify(validPayload);

  it("accepts JSON with leading and trailing newlines", () => {
    const input = `\n${jsonString}\n`;
    expect(parseMissionPlanJson(input)).toEqual(validPayload);
  });

  it("accepts JSON with leading and trailing spaces", () => {
    const input = `  ${jsonString}  `;
    expect(parseMissionPlanJson(input)).toEqual(validPayload);
  });

  it("accepts JSON with mixed whitespace and newlines", () => {
    const input = `\n  \n${jsonString}\n  \n`;
    expect(parseMissionPlanJson(input)).toEqual(validPayload);
  });

  it("accepts JSON wrapped in Markdown code fences with whitespace", () => {
    const input = `\n\`\`\`json\n${jsonString}\n\`\`\`\n`;
    expect(parseMissionPlanJson(input)).toEqual(validPayload);
  });
});