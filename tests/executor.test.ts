import { describe, expect, it } from "vitest";
import type { PlannedAction } from "../src/contracts/task.js";
import type { RepositoryContextFile } from "../src/github/repository-context.js";
import {
  ExecutionError,
  MissionExecutor,
  type CodePublisherFn,
  type CodeWorkerFn,
  type WorkerFn,
} from "../src/mission-control/executor.js";
import { MissionControl } from "../src/mission-control/mission-control.js";
import { MemoryAgentRunStore } from "../src/store/agent-run-store.js";
import { MemoryTaskStore } from "../src/store/task-store.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

async function createPlannedTask(
  action: PlannedAction,
  projectId?: string,
) {
  const taskStore = new MemoryTaskStore();
  const control = new MissionControl(taskStore);
  const task = await control.intake({
    title: "Analyze dashboard behavior",
    description: "Review dashboard behavior and recommend next steps",
    requestedBy: "Abu",
    category: "docs",
    projectId,
  });
  const planned = await control.addPlan(task.id, [action]);
  return { taskStore, planned };
}

describe("MissionExecutor", () => {
  it("executes analysis work and records the agent run", async () => {
    const { taskStore, planned } = await createPlannedTask({
      id: "analysis",
      kind: "analyze",
      summary: "Analyze dashboard behavior",
      target: "dashboard",
      reversible: true,
    });
    const runStore = new MemoryAgentRunStore();
    const worker: WorkerFn = async () => ({
      summary: "Dashboard needs clearer empty states",
      evidence: ["Current task requests a dashboard behavior review"],
      recommendations: ["Define empty-state acceptance criteria"],
      requiresHuman: false,
    });

    const mission = await new MissionExecutor(
      taskStore,
      runStore,
      worker,
      "test-model",
    ).execute(planned.id);

    expect(mission.task.status).toBe("completed");
    expect(mission.results).toHaveLength(1);
    expect([...runStore.runs.values()][0]?.status).toBe("succeeded");
  });

  it("passes bounded repository evidence to project analysis workers", async () => {
    const { taskStore, planned } = await createPlannedTask({
      id: "analysis",
      kind: "analyze",
      summary: "Analyze project implementation",
      target: "repository",
      reversible: true,
    }, PROJECT_ID);
    const runStore = new MemoryAgentRunStore();
    let received: readonly RepositoryContextFile[] | undefined;
    const worker: WorkerFn = async (_task, _action, repositoryContext) => {
      received = repositoryContext;
      return {
        summary: "Repository context analyzed",
        evidence: ["README.md@abc123"],
        recommendations: ["Continue with scoped analysis"],
        requiresHuman: false,
      };
    };
    const contextLoader = async (): Promise<readonly RepositoryContextFile[]> => [{
      repository: "Abuhurerakhan0407/abu-ai-software-factory",
      path: "README.md",
      ref: "main",
      sha: "abc123",
      content: "safe project overview",
    }];

    const mission = await new MissionExecutor(
      taskStore,
      runStore,
      worker,
      "test-model",
      contextLoader,
    ).execute(planned.id);

    expect(mission.task.status).toBe("completed");
    expect(received).toEqual(await contextLoader());
  });

  it("fails closed when repository context cannot be loaded", async () => {
    const { taskStore, planned } = await createPlannedTask({
      id: "analysis",
      kind: "analyze",
      summary: "Analyze project implementation",
      target: "repository",
      reversible: true,
    }, PROJECT_ID);
    const runStore = new MemoryAgentRunStore();
    let workerCalled = false;
    const worker: WorkerFn = async () => {
      workerCalled = true;
      throw new Error("worker must not run");
    };

    const mission = await new MissionExecutor(
      taskStore,
      runStore,
      worker,
      "test-model",
      async () => {
        throw new Error("repository unavailable");
      },
    ).execute(planned.id);

    expect(mission.task.status).toBe("failed");
    expect(workerCalled).toBe(false);
    expect([...runStore.runs.values()][0]?.status).toBe("failed");
  });

  it("fails closed when a mutating tool adapter is unavailable", async () => {
    const { taskStore, planned } = await createPlannedTask({
      id: "code",
      kind: "modify_code",
      summary: "Modify dashboard code",
      target: "dashboard",
      reversible: true,
    });
    const runStore = new MemoryAgentRunStore();
    let workerCalled = false;
    const worker: WorkerFn = async () => {
      workerCalled = true;
      throw new Error("worker must not run");
    };

    const mission = await new MissionExecutor(
      taskStore,
      runStore,
      worker,
      "test-model",
    ).execute(planned.id);

    expect(mission.task.status).toBe("human_required");
    expect(workerCalled).toBe(false);
    expect(runStore.runs.size).toBe(0);
  });

  it("publishes modify_code work only through a draft-PR publisher", async () => {
    const { taskStore, planned } = await createPlannedTask({
      id: "code",
      kind: "modify_code",
      summary: "Modify dashboard code",
      target: "dashboard",
      reversible: true,
    }, PROJECT_ID);
    const runStore = new MemoryAgentRunStore();
    const contextLoader = async (): Promise<readonly RepositoryContextFile[]> => [{
      repository: "abu/school-saas",
      path: "src/dashboard.ts",
      ref: "main",
      sha: "source-sha-123",
      content: "export const dashboard = false;\n",
    }];
    const codeWorker: CodeWorkerFn = async () => ({
      summary: "Dashboard implementation updated",
      changes: [{
        operation: "update",
        path: "src/dashboard.ts",
        sourceSha: "source-sha-123",
        content: "export const dashboard = true;\n",
      }],
      requiresHuman: false,
    });
    const codePublisher: CodePublisherFn = async () => ({
      projectId: PROJECT_ID,
      repository: "abu/school-saas",
      branch: "factory/" + planned.id,
      pullRequest: {
        number: 27,
        url: "https://github.com/abu/school-saas/pull/27",
        draft: true,
      },
      files: ["src/dashboard.ts"],
    });

    const mission = await new MissionExecutor(
      taskStore,
      runStore,
      undefined,
      "test-model",
      contextLoader,
      codeWorker,
      codePublisher,
    ).execute(planned.id);

    expect(mission.task.status).toBe("human_required");
    expect(mission.results[0]?.result.evidence[0]).toContain("Draft PR #27");
    expect([...runStore.runs.values()][0]?.status).toBe("succeeded");
  });

  it("refuses tasks still waiting for approval", async () => {
    const { taskStore, planned } = await createPlannedTask({
      id: "production",
      kind: "deploy_production",
      summary: "Deploy release to production",
      target: "production",
      reversible: true,
    });
    const runStore = new MemoryAgentRunStore();
    const worker: WorkerFn = async () => {
      throw new Error("worker must not run");
    };

    const executor = new MissionExecutor(
      taskStore,
      runStore,
      worker,
      "test-model",
    );

    expect(planned.status).toBe("awaiting_approval");
    await expect(executor.execute(planned.id)).rejects.toMatchObject({
      code: "task_not_executable",
    } satisfies Partial<ExecutionError>);
    expect(runStore.runs.size).toBe(0);
  });

  it("stops when an agent requests human review", async () => {
    const { taskStore, planned } = await createPlannedTask({
      id: "analysis",
      kind: "analyze",
      summary: "Analyze uncertain behavior",
      target: "dashboard",
      reversible: true,
    });
    const runStore = new MemoryAgentRunStore();
    const worker: WorkerFn = async () => ({
      summary: "Evidence is insufficient",
      evidence: [],
      recommendations: ["Request repository evidence"],
      requiresHuman: true,
    });

    const mission = await new MissionExecutor(
      taskStore,
      runStore,
      worker,
      "test-model",
    ).execute(planned.id);

    expect(mission.task.status).toBe("human_required");
    expect([...runStore.runs.values()][0]?.status).toBe("succeeded");
  });
});
