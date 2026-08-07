import { describe, expect, it } from "vitest";
import type { PlannedAction, TaskRecord } from "../src/contracts/task.js";
import {
  ProductionDeploymentGate,
} from "../src/deployment/production-deployment-gate.js";
import { MemoryProjectStore } from "../src/store/project-store.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function task(approved: boolean): TaskRecord {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Deploy verified school SaaS",
    description: "Promote verified factory pull request",
    requestedBy: "Abu",
    projectId: PROJECT_ID,
    category: "deployment",
    assignedAgent: "sre",
    risk: "high",
    status: "executing",
    plan: [],
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    audit: approved ? [{
      at: "2026-08-07T00:00:00.000Z",
      actor: "Abu",
      event: "production_approval_granted",
      detail: JSON.stringify({
        pullRequest: 42,
        headSha: "abcdef1234567890abcdef1234567890abcdef12",
      }),
    }] : [],
  };
}

const action = {
  id: "deploy",
  kind: "deploy_production",
  summary: "Promote verified pull request",
  target: "pull_request:42",
  reversible: true,
} satisfies PlannedAction;

describe("production deployment gate", () => {
  it("blocks production without explicit human approval", async () => {
    const projects = new MemoryProjectStore();
    await expect(new ProductionDeploymentGate(projects).deploy(task(false), action))
      .rejects.toMatchObject({ code: "approval_required" });
  });

  it("promotes only configured verified pull request", async () => {
    const projects = new MemoryProjectStore();
    await projects.upsert({
      id: PROJECT_ID,
      name: "School SaaS",
      repository: "abu/school-saas",
      status: "active",
      config: {
        deployment: {
          provider: "vercel",
          productionBranch: "main",
          vercelProjectId: "prj_school123",
        },
      },
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    });

    let called = false;
    const gate = new ProductionDeploymentGate(projects, () => ({
      inspectVerifiedFactoryPullRequest: async () => ({
        pullRequest: 42,
        url: "https://github.com/abu/school-saas/pull/42",
        sourceHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
      }),
      promoteVerifiedFactoryPullRequest: async (input) => {
        called = input.pullRequest === 42
          && input.productionBranch === "main"
          && input.expectedHeadSha === "abcdef1234567890abcdef1234567890abcdef12";
        return {
          pullRequest: 42,
          url: "https://github.com/abu/school-saas/pull/42",
          sourceHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
          productionCommitSha: "fedcba0987654321fedcba0987654321fedcba09",
        };
      },
    }));

    const result = await gate.deploy(task(true), action);
    expect(called).toBe(true);
    expect(result.triggered).toBe(true);
    expect(result.productionCommitSha).toBe(
      "fedcba0987654321fedcba0987654321fedcba09",
    );
  });
});
