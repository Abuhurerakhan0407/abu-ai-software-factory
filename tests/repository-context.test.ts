import { describe, expect, it } from "vitest";
import type {
  PlannedAction,
  TaskRecord,
} from "../src/contracts/task.js";
import {
  RepositoryContextError,
  SafeRepositoryContext,
} from "../src/github/repository-context.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

const action: PlannedAction = {
  id: "analysis",
  kind: "analyze",
  summary: "Analyze repository",
  target: "repository",
  reversible: true,
};

const task = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Analyze repository",
  description: "Use safe repository evidence",
  requestedBy: "Abu",
  projectId: PROJECT_ID,
  category: "docs",
  assignedAgent: "engineer",
  risk: "low",
  status: "executing",
  plan: [action],
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
  audit: [],
} satisfies TaskRecord;

describe("SafeRepositoryContext", () => {
  it("loads approved bootstrap files within one bounded budget", async () => {
    const reader = {
      read: async (input: { projectId: string; path: string; ref: string }) => ({
        projectId: input.projectId,
        repository: "Abuhurerakhan0407/abu-ai-software-factory",
        path: input.path,
        ref: input.ref,
        sha: `sha-${input.path}`,
        content: "x".repeat(20_000),
      }),
    };
    const context = await new SafeRepositoryContext(reader)
      .load(task, action);

    expect(context).toHaveLength(2);
    expect(context.reduce((sum, file) => sum + file.content.length, 0))
      .toBe(24_000);
  });

  it("continues when an optional bootstrap file is missing", async () => {
    const reader = {
      read: async (input: { projectId: string; path: string; ref: string }) => {
        if (input.path === "README.md") throw new Error("not found");
        return {
          projectId: input.projectId,
          repository: "Abuhurerakhan0407/abu-ai-software-factory",
          path: input.path,
          ref: input.ref,
          sha: "package-sha",
          content: "{}",
        };
      },
    };
    const context = await new SafeRepositoryContext(reader)
      .load(task, action);

    expect(context.map((file) => file.path)).toEqual(["package.json"]);
  });

  it("fails closed when no safe context file can be loaded", async () => {
    const reader = {
      read: async () => {
        throw new Error("unavailable");
      },
    };

    await expect(
      new SafeRepositoryContext(reader).load(task, action),
    ).rejects.toBeInstanceOf(RepositoryContextError);
  });

  it("does not read repository context for unregistered tasks", async () => {
    let reads = 0;
    const reader = {
      read: async () => {
        reads += 1;
        throw new Error("must not read");
      },
    };
    const context = await new SafeRepositoryContext(reader).load(
      { ...task, projectId: null },
      action,
    );

    expect(context).toEqual([]);
    expect(reads).toBe(0);
  });
});
