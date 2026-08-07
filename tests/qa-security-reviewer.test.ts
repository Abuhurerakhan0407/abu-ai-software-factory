import { describe, expect, it } from "vitest";
import {
  qaReviewBlocks,
  type QaSecurityReview,
} from "../src/agents/qa-security-reviewer.js";

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
