import { describe, expect, it, vi } from "vitest";
import type { CodeWorkResult } from "../src/agents/code-worker.js";
import type { PlannedAction, TaskRecord } from "../src/contracts/task.js";
import { VerifiedCodePublisher } from "../src/execution/verified-code-publisher.js";
import { SafeCodePublisher } from "../src/github/safe-code-publisher.js";
import { MemoryProjectStore } from "../src/store/project-store.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const BRANCH = "factory/" + TASK_ID;

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

const work = {
  summary: "Scoped dashboard fix",
  changes: [{
    operation: "update",
    path: "src/dashboard.ts",
    sourceSha: "source-sha-123",
    content: "export const dashboard = true;\n",
  }],
  requiresHuman: false,
} satisfies CodeWorkResult;

const passingQa = vi.fn(async () => ({
  verdict: "pass" as const,
  summary: "Independent QA/security review passed",
  findings: [],
}));

async function setup() {
  const projects = new MemoryProjectStore();
  await projects.upsert({
    id: PROJECT_ID,
    name: "School SaaS",
    repository: "abu/school-saas",
    status: "active",
    config: {},
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  });

  const gateway = {
    listTree: vi.fn(async (ref: string) => ({
      entries: [{
        path: "src/dashboard.ts",
        type: "blob" as const,
        sha: ref === "main" ? "source-sha-123" : "branch-sha-456",
        size: 50,
      }],
      truncated: false,
    })),
    createFactoryBranch: vi.fn(async () => BRANCH),
    writeFile: vi.fn(async () => undefined),
    openDraftPullRequest: vi.fn(async () => ({
      number: 31,
      url: "https://github.com/abu/school-saas/pull/31",
      draft: true as const,
    })),
  };

  return {
    gateway,
    publisher: new SafeCodePublisher(projects, () => gateway),
  };
}

describe("VerifiedCodePublisher", () => {
  it("opens a draft PR only after sandbox checks pass", async () => {
    const { gateway, publisher } = await setup();
    const verifier = {
      verify: vi.fn(async () => ({
        passed: true,
        repairable: false,
        summary: "Isolated sandbox checks passed",
        checks: [{
          label: "test" as const,
          command: "npm test",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }],
      })),
    };

    const publication = await new VerifiedCodePublisher(
      publisher,
      verifier,
      vi.fn(),
      passingQa,
    ).publish(task, action, work);

    expect(publication.pullRequest.draft).toBe(true);
    expect(publication.verification?.repairAttempts).toBe(0);
    expect(gateway.openDraftPullRequest).toHaveBeenCalledOnce();
  });

  it("repairs once, reruns checks, then opens the draft PR", async () => {
    const { gateway, publisher } = await setup();
    const verifier = {
      verify: vi.fn()
        .mockResolvedValueOnce({
          passed: false,
          repairable: true,
          summary: "test failed in the isolated sandbox",
          checks: [{
            label: "test" as const,
            command: "npm test",
            exitCode: 1,
            stdout: "failed",
            stderr: "",
          }],
        })
        .mockResolvedValueOnce({
          passed: true,
          repairable: false,
          summary: "Isolated sandbox checks passed",
          checks: [{
            label: "test" as const,
            command: "npm test",
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          }],
        }),
    };
    const repair = vi.fn(async () => ({
      summary: "Repaired generated dashboard code",
      changes: [{
        path: "src/dashboard.ts",
        content: "export const dashboard = true as const;\n",
      }],
      requiresHuman: false,
    }));

    const publication = await new VerifiedCodePublisher(
      publisher,
      verifier,
      repair,
      passingQa,
    ).publish(task, action, work);

    expect(verifier.verify).toHaveBeenCalledTimes(2);
    expect(repair).toHaveBeenCalledOnce();
    expect(gateway.writeFile).toHaveBeenCalledTimes(2);
    expect(publication.verification?.repairAttempts).toBe(1);
    expect(gateway.openDraftPullRequest).toHaveBeenCalledOnce();
  });

  it("keeps production unchanged when sandbox checks still fail", async () => {
    const { gateway, publisher } = await setup();
    const verifier = {
      verify: vi.fn(async () => ({
        passed: false,
        repairable: true,
        summary: "test failed in the isolated sandbox",
        checks: [{
          label: "test" as const,
          command: "npm test",
          exitCode: 1,
          stdout: "failed",
          stderr: "",
        }],
      })),
    };

    await expect(new VerifiedCodePublisher(
      publisher,
      verifier,
      async () => ({
        summary: "Repair needs human review",
        changes: [],
        requiresHuman: true,
      }),
      passingQa,
    ).publish(task, action, work)).rejects.toMatchObject({
      code: "sandbox_failed",
    });

    expect(gateway.openDraftPullRequest).not.toHaveBeenCalled();
  });
});
