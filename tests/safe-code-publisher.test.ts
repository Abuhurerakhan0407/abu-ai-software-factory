import { describe, expect, it, vi } from "vitest";
import type { PlannedAction, TaskRecord } from "../src/contracts/task.js";
import type { CodeWorkResult } from "../src/agents/code-worker.js";
import { SafeCodePublisher } from "../src/github/safe-code-publisher.js";
import { MemoryProjectStore } from "../src/store/project-store.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";

const task = {
  id: TASK_ID,
  title: "Fix dashboard behavior",
  description: "Make the scoped dashboard fix",
  requestedBy: "Abu",
  projectId: PROJECT_ID,
  category: "bug",
  assignedAgent: "engineer",
  risk: "medium",
  status: "executing",
  plan: [],
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
  audit: [],
} satisfies TaskRecord;

const action = {
  id: "code",
  kind: "modify_code",
  summary: "Modify dashboard code",
  target: "src/dashboard.ts",
  reversible: true,
} satisfies PlannedAction;

async function projectStore() {
  const store = new MemoryProjectStore();
  await store.upsert({
    id: PROJECT_ID,
    name: "School SaaS",
    repository: "abu/school-saas",
    status: "active",
    config: {},
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  });
  return store;
}

function gateway() {
  return {
    listTree: vi.fn(async () => ({
      entries: [
        { path: "src/dashboard.ts", type: "blob" as const, sha: "source-sha-123", size: 50 },
      ],
      truncated: false,
    })),
    createFactoryBranch: vi.fn(async () => "factory/" + TASK_ID),
    writeFile: vi.fn(async () => undefined),
    openDraftPullRequest: vi.fn(async () => ({
      number: 27,
      url: "https://github.com/abu/school-saas/pull/27",
      draft: true as const,
    })),
  };
}

describe("SafeCodePublisher", () => {
  it("publishes bounded updates and creates as a draft PR", async () => {
    const store = await projectStore();
    const fake = gateway();
    const work = {
      summary: "Scoped dashboard fix",
      changes: [
        {
          operation: "update",
          path: "src/dashboard.ts",
          sourceSha: "source-sha-123",
          content: "export const dashboard = true;\n",
        },
        {
          operation: "create",
          path: "src/dashboard-helper.ts",
          content: "export const helper = true;\n",
        },
      ],
      requiresHuman: false,
    } satisfies CodeWorkResult;

    const published = await new SafeCodePublisher(store, () => fake)
      .publish(task, action, work);

    expect(published.pullRequest.draft).toBe(true);
    expect(published.files).toEqual(["src/dashboard.ts", "src/dashboard-helper.ts"]);
    expect(fake.writeFile).toHaveBeenCalledTimes(2);
    expect(fake.openDraftPullRequest).toHaveBeenCalledOnce();
  });

  it("rejects protected workflow paths before branch creation", async () => {
    const store = await projectStore();
    const fake = gateway();
    const work = {
      summary: "Unsafe workflow edit",
      changes: [{
        operation: "create",
        path: ".github/workflows/unsafe.yml",
        content: "name: unsafe\n",
      }],
      requiresHuman: false,
    } satisfies CodeWorkResult;

    await expect(
      new SafeCodePublisher(store, () => fake).publish(task, action, work),
    ).rejects.toMatchObject({ code: "invalid_change" });
    expect(fake.createFactoryBranch).not.toHaveBeenCalled();
  });

  it("rejects stale update SHAs before repository writes", async () => {
    const store = await projectStore();
    const fake = gateway();
    const work = {
      summary: "Stale dashboard edit",
      changes: [{
        operation: "update",
        path: "src/dashboard.ts",
        sourceSha: "old-source-sha",
        content: "export const dashboard = false;\n",
      }],
      requiresHuman: false,
    } satisfies CodeWorkResult;

    await expect(
      new SafeCodePublisher(store, () => fake).publish(task, action, work),
    ).rejects.toMatchObject({ code: "stale_source" });
    expect(fake.createFactoryBranch).not.toHaveBeenCalled();
    expect(fake.writeFile).not.toHaveBeenCalled();
  });
});
