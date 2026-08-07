import { describe, expect, it, vi } from "vitest";
import type { PlannedAction, TaskRecord } from "../src/contracts/task.js";
import {
  redactRepositorySecrets,
  SourceAwareRepositoryContext,
  SourceRepositoryContextError,
} from "../src/github/source-context.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

const action: PlannedAction = {
  id: "analysis",
  kind: "analyze",
  summary: "Analyze dashboard API behavior",
  target: "dashboard",
  reversible: true,
};

const task = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Fix dashboard API",
  description: "Inspect dashboard implementation and API behavior",
  requestedBy: "Abu",
  projectId: PROJECT_ID,
  category: "bug",
  assignedAgent: "engineer",
  risk: "low",
  status: "executing",
  plan: [action],
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
  audit: [],
} satisfies TaskRecord;

function tree() {
  return {
    projectId: PROJECT_ID,
    repository: "Abuhurerakhan0407/abu-ai-software-factory",
    ref: "main",
    entries: [
      { path: "src/dashboard.ts", type: "blob" as const, sha: "1", size: 100 },
      { path: "api/dashboard.ts", type: "blob" as const, sha: "2", size: 100 },
      { path: "src/other.ts", type: "blob" as const, sha: "3", size: 100 },
      { path: "src/fourth.ts", type: "blob" as const, sha: "4", size: 100 },
      { path: "README.md", type: "blob" as const, sha: "5", size: 100 },
      { path: "package.json", type: "blob" as const, sha: "6", size: 100 },
      { path: "dist/dashboard.js", type: "blob" as const, sha: "7", size: 100 },
    ],
  };
}

describe("SourceAwareRepositoryContext", () => {
  it("selects at most five bounded task-relevant files", async () => {
    const navigator = { list: vi.fn(async () => tree()) };
    const reader = {
      read: vi.fn(async (input: { projectId: string; path: string; ref: string }) => ({
        projectId: input.projectId,
        repository: "Abuhurerakhan0407/abu-ai-software-factory",
        path: input.path,
        ref: input.ref,
        sha: `sha-${input.path}`,
        content: "x".repeat(20_000),
      })),
    };

    const context = await new SourceAwareRepositoryContext(reader, navigator)
      .load(task, action);

    expect(context).toHaveLength(5);
    expect(context[0]?.path).toBe("api/dashboard.ts");
    expect(context[1]?.path).toBe("src/dashboard.ts");
    expect(context.map((file) => file.path)).not.toContain("dist/dashboard.js");
    expect(context.every((file) => file.content.length <= 12_000)).toBe(true);
    expect(context.reduce((sum, file) => sum + file.content.length, 0))
      .toBeLessThanOrEqual(48_000);
  });

  it("redacts common secret forms before model context", () => {
    const content = [
      'const apiKey = "supersecretvalue123";',
      "postgresql://postgres:database-password@example.test:5432/postgres",
      "sk-abcdefghijklmnopqrstuv",
      "AKIA1234567890ABCDEF",
    ].join("\n");

    const redacted = redactRepositorySecrets(content);

    expect(redacted).not.toContain("supersecretvalue123");
    expect(redacted).not.toContain("database-password");
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(redacted).not.toContain("AKIA1234567890ABCDEF");
    expect(redacted).toContain("[REDACTED_SECRET]");
  });

  it("does not inspect repositories for project-less tasks", async () => {
    const navigator = { list: vi.fn(async () => tree()) };
    const reader = { read: vi.fn() };

    const context = await new SourceAwareRepositoryContext(reader, navigator)
      .load({ ...task, projectId: null }, action);

    expect(context).toEqual([]);
    expect(navigator.list).not.toHaveBeenCalled();
    expect(reader.read).not.toHaveBeenCalled();
  });

  it("fails closed when every selected source read fails", async () => {
    const navigator = { list: vi.fn(async () => tree()) };
    const reader = {
      read: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    };

    await expect(
      new SourceAwareRepositoryContext(reader, navigator).load(task, action),
    ).rejects.toBeInstanceOf(SourceRepositoryContextError);
  });
});
