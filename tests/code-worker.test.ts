import { describe, expect, it } from "vitest";
import {
  exactContentCodeWork,
  parseCodeWorkJson,
} from "../src/agents/code-worker.js";
import type { PlannedAction } from "../src/contracts/task.js";
import type { RepositoryContextFile } from "../src/github/repository-context.js";

const action = {
  id: "1-modify_code",
  kind: "modify_code",
  summary: "Create exact smoke-test file",
  expectedContent: "Autopilot Gemma coding-agent smoke test passed.",
  target: "docs/autopilot-gemma-smoke.md",
  reversible: true,
} satisfies PlannedAction;

const readmeContext: RepositoryContextFile = {
  repository: "Abuhurerakhan0407/abu-ai-software-factory",
  path: "README.md",
  ref: "main",
  sha: "readme-sha-123",
  content: "Factory repository",
};

describe("parseCodeWorkJson", () => {
  const payload = {
    summary: "Prepared documentation smoke test",
    changes: [{
      operation: "create" as const,
      path: action.target,
      content: action.expectedContent,
    }],
    requiresHuman: false,
  };

  it("accepts raw JSON output", () => {
    expect(parseCodeWorkJson(JSON.stringify(payload))).toEqual(payload);
  });

  it("accepts JSON wrapped in one Markdown fence", () => {
    const fenced = "```json\n" + JSON.stringify(payload) + "\n```";
    expect(parseCodeWorkJson(fenced)).toEqual(payload);
  });
});

describe("exactContentCodeWork", () => {
  it("creates a missing exact-content target without using a model", () => {
    expect(exactContentCodeWork(action, [readmeContext])).toEqual({
      summary: "Prepared exact planned content for " + action.target,
      changes: [{
        operation: "create",
        path: action.target,
        content: action.expectedContent,
      }],
      requiresHuman: false,
    });
  });

  it("updates an existing exact-content target using its source SHA", () => {
    const existing: RepositoryContextFile = {
      ...readmeContext,
      path: action.target,
      sha: "existing-sha-123",
      content: "old content",
    };

    expect(exactContentCodeWork(action, [existing])).toEqual({
      summary: "Prepared exact planned content for " + action.target,
      changes: [{
        operation: "update",
        path: action.target,
        sourceSha: existing.sha,
        content: action.expectedContent,
      }],
      requiresHuman: false,
    });
  });
});
