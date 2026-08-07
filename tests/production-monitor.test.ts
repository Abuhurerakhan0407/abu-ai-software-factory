import { describe, expect, it } from "vitest";
import type { PlannedAction } from "../src/contracts/task.js";
import {
  ProductionMonitor,
  type ProductionMonitoringGateway,
} from "../src/deployment/production-monitor.js";
import { MissionControl } from "../src/mission-control/mission-control.js";
import { MemoryProjectStore } from "../src/store/project-store.js";
import { MemoryTaskStore } from "../src/store/task-store.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const headSha = "abcdef1234567890abcdef1234567890abcdef12";
const productionSha = "fedcba0987654321fedcba0987654321fedcba09";

async function setup() {
  const tasks = new MemoryTaskStore();
  const projects = new MemoryProjectStore();
  const control = new MissionControl(tasks);
  const now = new Date().toISOString();
  await projects.upsert({
    id: projectId,
    name: "School SaaS",
    repository: "Abuhurerakhan0407/school-saas",
    status: "active",
    config: {
      deployment: {
        provider: "vercel",
        productionBranch: "main",
        vercelProjectId: "prj_school123",
        healthPath: "/api/health",
      },
    },
    createdAt: now,
    updatedAt: now,
  });

  const task = await control.intake({
    title: "Deploy verified school SaaS",
    description: "Promote and monitor verified factory pull request",
    requestedBy: "Abu",
    category: "deployment",
    projectId,
  });
  const action = {
    id: "deploy",
    kind: "deploy_production",
    summary: "Promote verified pull request",
    target: "pull_request:42",
    reversible: true,
  } satisfies PlannedAction;
  await control.addPlan(task.id, [action]);
  await control.approveProduction(task.id, { pullRequest: 42, headSha }, "Abu");
  await control.recordProductionDeployment(task.id, {
    vercelProjectId: "prj_school123",
    pullRequest: 42,
    sourceHeadSha: headSha,
    productionCommitSha: productionSha,
  });
  await control.transition(task.id, "verifying", "qa_security", "Verified");
  await control.transition(task.id, "staging", "qa_security", "Staged");
  await control.transition(task.id, "deploying", "sre", "Production triggered");

  return { tasks, projects, taskId: task.id };
}

describe("production monitoring", () => {
  it("requires two consecutive healthy samples before completion", async () => {
    const { tasks, projects, taskId } = await setup();
    const gateway: ProductionMonitoringGateway = {
      observe: async () => ({
        status: "healthy",
        deploymentId: "dpl_current",
        reason: "Health endpoint returned 200",
      }),
      rollback: async () => "completed",
    };
    const monitor = new ProductionMonitor(tasks, projects, gateway);

    const first = await monitor.monitor(taskId);
    expect(first.task.status).toBe("monitoring");
    expect(first.healthySamples).toBe(1);

    const second = await monitor.monitor(taskId);
    expect(second.task.status).toBe("completed");
    expect(second.healthySamples).toBe(2);
    expect(second.rollback).toBe("none");
  });

  it("rolls back only after three consecutive unhealthy samples", async () => {
    const { tasks, projects, taskId } = await setup();
    let rollbackCalls = 0;
    const gateway: ProductionMonitoringGateway = {
      observe: async () => ({
        status: "unhealthy",
        deploymentId: "dpl_current",
        rollbackDeploymentId: "dpl_previous",
        reason: "Health endpoint returned 500",
      }),
      rollback: async (input) => {
        rollbackCalls += 1;
        expect(input.deploymentId).toBe("dpl_previous");
        return "completed";
      },
    };
    const monitor = new ProductionMonitor(tasks, projects, gateway);

    expect((await monitor.monitor(taskId)).task.status).toBe("monitoring");
    expect((await monitor.monitor(taskId)).task.status).toBe("monitoring");
    const third = await monitor.monitor(taskId);

    expect(third.task.status).toBe("rolled_back");
    expect(third.unhealthySamples).toBe(3);
    expect(third.rollback).toBe("completed");
    expect(rollbackCalls).toBe(1);
  });

  it("escalates when plan or permissions cannot rollback", async () => {
    const { tasks, projects, taskId } = await setup();
    const gateway: ProductionMonitoringGateway = {
      observe: async () => ({
        status: "unhealthy",
        deploymentId: "dpl_current",
        rollbackDeploymentId: "dpl_previous",
        reason: "Health endpoint returned 500",
      }),
      rollback: async () => "unsupported",
    };
    const monitor = new ProductionMonitor(tasks, projects, gateway);

    await monitor.monitor(taskId);
    await monitor.monitor(taskId);
    const third = await monitor.monitor(taskId);

    expect(third.task.status).toBe("human_required");
    expect(third.rollback).toBe("unsupported");
  });
});
