import { describe, expect, it } from "vitest";
import type { PlannedAction } from "../src/contracts/task.js";
import type { RepositoryContextFile } from "../src/github/repository-context.js";
import {
  MissionExecutor,
  type StagingDatabaseFn,
  type StagingMigrationWorkerFn,
} from "../src/mission-control/executor.js";
import { MissionControl } from "../src/mission-control/mission-control.js";
import { MemoryAgentRunStore } from "../src/store/agent-run-store.js";
import { MemoryTaskStore } from "../src/store/task-store.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("staging migration execution", () => {
  it("routes database work through staging gate and records production untouched", async () => {
    const taskStore = new MemoryTaskStore();
    const control = new MissionControl(taskStore);
    const task = await control.intake({
      title: "Add attendance table",
      description: "Create additive attendance schema in staging",
      requestedBy: "Abu",
      category: "docs",
      projectId: PROJECT_ID,
    });
    const action = {
      id: "db",
      kind: "migrate_staging_db",
      summary: "Create attendance schema",
      target: "staging database",
      reversible: true,
    } satisfies PlannedAction;
    const planned = await control.addPlan(task.id, [action]);
    const runStore = new MemoryAgentRunStore();

    const contextLoader = async (): Promise<readonly RepositoryContextFile[]> => [{
      repository: "abu/school-saas",
      path: "src/db/schema.ts",
      ref: "main",
      sha: "abc1234",
      content: "attendance schema context",
    }];
    const migrationWorker: StagingMigrationWorkerFn = async () => ({
      summary: "Add attendance table",
      sql: "CREATE TABLE attendance (id uuid primary key);",
      requiresHuman: false,
    });
    let gateCalled = false;
    const stagingDatabase: StagingDatabaseFn = async () => {
      gateCalled = true;
      return {
        applied: true,
        environment: "staging",
        fingerprint: "abc123def4567890",
        statements: 1,
      };
    };

    const mission = await new MissionExecutor(
      taskStore,
      runStore,
      undefined,
      "test-model",
      contextLoader,
      undefined,
      undefined,
      migrationWorker,
      stagingDatabase,
    ).execute(planned.id);

    expect(gateCalled).toBe(true);
    expect(mission.task.status).toBe("completed");
    expect(mission.results[0]?.result.evidence).toContain("Production database untouched");
    expect([...runStore.runs.values()][0]?.status).toBe("succeeded");
  });
});
