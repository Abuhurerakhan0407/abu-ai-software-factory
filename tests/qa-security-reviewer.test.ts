import { describe, expect, it } from "vitest";
import {
  exactContentReview,
  parseQaSecurityReviewJson,
  qaReviewBlocks,
  type QaSecurityReview,
} from "../src/agents/qa-security-reviewer.js";
import type { PlannedAction } from "../src/contracts/task.js";

function review(
  verdict: QaSecurityReview["verdict"],
  severity?: "low" | "medium" | "high" | "critical",
): QaSecurityReview {
  return {
    verdict,
    summary: "Independent review result",
    findings: severity
      ? [{
          severity,
          category: "security",
          path: "src/example.ts",
          summary: "Example finding",
          recommendation: "Fix before merge",
        }]
      : [],
  };
}

describe("qaReviewBlocks", () => {
  it("allows a passing review without blocking findings", () => {
    expect(qaReviewBlocks(review("pass"))).toBe(false);
    expect(qaReviewBlocks(review("pass", "medium"))).toBe(false);
  });

  it("blocks high and critical findings even when verdict says pass", () => {
    expect(qaReviewBlocks(review("pass", "high"))).toBe(true);
    expect(qaReviewBlocks(review("pass", "critical"))).toBe(true);
  });

  it("fails closed when reviewer requests a human", () => {
    expect(qaReviewBlocks(review("human_required"))).toBe(true);
  });
});


describe("exactContentReview", () => {
  const action = {
    id: "1-modify_code",
    kind: "modify_code",
    summary: "Create exact smoke-test file",
    expectedContent: "Autopilot coding-agent smoke test passed.",
    target: "docs/autopilot-agent-smoke.md",
    reversible: true,
  } satisfies PlannedAction;

  it("passes only the exact planned literal content", () => {
    expect(exactContentReview(action, [{
      path: action.target,
      content: action.expectedContent,
    }])).toBeUndefined();
  });

  it("blocks task instructions leaking into exact file content", () => {
    expect(exactContentReview(action, [{
      path: action.target,
      content: action.expectedContent + " Publish changes only through a draft",
    }])).toMatchObject({
      verdict: "human_required",
      findings: [{
        severity: "high",
        category: "correctness",
        path: action.target,
      }],
    });
  });
});


describe("parseQaSecurityReviewJson", () => {
  const payload = {
    verdict: "pass" as const,
    summary: "Independent review passed",
    findings: [],
  };

  it("accepts raw JSON recovery output", () => {
    expect(parseQaSecurityReviewJson(JSON.stringify(payload))).toEqual(payload);
  });

  it("accepts a single JSON code fence", () => {
    const fenced = "```json\n" + JSON.stringify(payload) + "\n```";
    expect(parseQaSecurityReviewJson(fenced)).toEqual(payload);
  });
});
