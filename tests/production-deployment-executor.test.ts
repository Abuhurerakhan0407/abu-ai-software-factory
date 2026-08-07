import { describe, expect, it } from "vitest";
import type { PlannedAction } from "../src/contracts/task.js";
import {
  MissionExecutor,
  type ProductionDeploymentFn,
} from "../src/mission-control/executor.js";
import { MissionControl } from "../src/mission-control/mission-control.js";
import { MemoryAgentRunStore } from "../src/store/agent-run-store.js";
import { MemoryTaskStore } from "../src/store/task-store.js";

describe("approved production deployment execution", () => {
  it("resumes an approved task and stops in deploying for monitoring", async () => {
    const taskStore = new MemoryTaskStore();
    const control = new MissionControl(taskStore);
    const task = await control.intake({
      title: "Deploy verified school SaaS",
      description: "Promote verified factory pull request",
      requestedBy: "Abu",
      category: "deployment",
      projectId: "11111111-1111-4111-8111-111111111111",
    });
    const action = {
      id: "deploy",
      kind: "deploy_production",
      summary: "Promote verified pull request",
      target: "pull_request:42",
      reversible: true,
    } satisfies PlannedAction;
    const awaiting = await control.addPlan(task.id, [action]);
    expect(awaiting.status).toBe("awaiting_approval");
    const approved = await control.approveProduction(task.id, {
      pullRequest: 42,
      headSha: "abcdef1234567890abcdef1234567890abcdef12",
    }, "Abu");
    expect(approved.status).toBe("executing");

    const deploy: ProductionDeploymentFn = async () => ({
      triggered: true,
      provider: "vercel",
      vercelProjectId: "prj_school123",
      pullRequest: 42,
      sourceHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
      productionCommitSha: "fedcba0987654321fedcba0987654321fedcba09",
    });

    const mission = await new MissionExecutor(
      taskStore,
      new MemoryAgentRunStore(),
      undefined,
      "test-model",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deploy,
    ).execute(task.id);

    expect(mission.task.status).toBe("deploying");
    expect(mission.results[0]?.result.evidence).toContain(
      "Vercel rollout awaiting monitoring",
    );
  });
});
