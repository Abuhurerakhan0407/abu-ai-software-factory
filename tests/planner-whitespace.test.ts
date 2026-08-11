import { describe, expect, it } from "vitest";
import { parseMissionPlanJson } from "../src/mission-control/mission-control.js";

describe("parseMissionPlanJson", () => {
  it("accepts valid JSON surrounded by whitespace", () => {
    const payload = {
      summary: "Whitespace test",
      actions: [{
        id: "1-test",
        kind: "modify_code",
        summary: "Test whitespace",
        target: "test.txt",
        reversible: true,
      }],
      requiresHuman: false,
    };

    const jsonString = JSON.stringify(payload);
    const whitespacePayload = `

  ${jsonString}  

`;

    expect(parseMissionPlanJson(whitespacePayload)).toEqual(payload);
  });

  it("accepts JSON with significant whitespace within the JSON structure", () => {
    const jsonWithWhitespace = `{
      "summary": "Whitespace test",
      "actions": [
        {
          "id": "1-test",
          "kind": "modify_code",
          "summary": "Test whitespace",
          "target": "test.txt",
          "reversible": true
        }
      ],
      "requiresHuman": false
    }`;

    const payload = {
      summary: "Whitespace test",
      actions: [{
        id: "1-test",
        kind: "modify_code",
        summary: "Test whitespace",
        target: "test.txt",
        reversible: true,
      }],
      requiresHuman: false,
    };

    expect(parseMissionPlanJson(jsonWithWhitespace)).toEqual(payload);
  });
});
