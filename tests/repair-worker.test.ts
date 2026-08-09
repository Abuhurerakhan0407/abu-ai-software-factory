import { describe, expect, it } from "vitest";
import { parseRepairWorkJson } from "../src/agents/repair-worker.js";

const expected = {
  summary: "Corrected generated test import",
  changes: [{
    path: "tests/planner-whitespace.test.ts",
    content: "export {};\n",
  }],
  requiresHuman: false,
};

describe("parseRepairWorkJson", () => {
  it("parses raw JSON repair output", () => {
    expect(parseRepairWorkJson(JSON.stringify(expected))).toEqual(expected);
  });

  it("accepts one Markdown JSON fence from free models", () => {
    const fence = String.fromCharCode(96).repeat(3);
    const output = fence + "json\n" + JSON.stringify(expected) + "\n" + fence;

    expect(parseRepairWorkJson(output)).toEqual(expected);
  });
});
