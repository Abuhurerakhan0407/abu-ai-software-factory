import type {
  PlannedAction,
  TaskRecord,
} from "../contracts/task.js";
import type {
  RepositoryContextFile,
  RepositoryContextLoader,
} from "../github/repository-context.js";
import type {
  AgentRunStore,
} from "../store/agent-run-store.js";
import type { TaskStore } from "../store/task-store.js";
import {
  executionModelName,
  runAnalysisWorker,
  type AgentWorkResult,
} from "../agents/role-worker.js";
import { MissionControl } from "./mission-control.js";

export type WorkerFn = (
  task: TaskRecord,
  action: PlannedAction,
  repositoryContext?: readonly RepositoryContextFile[],
) => Promise<AgentWorkResult>;

export class ExecutionError extends Error {
  constructor(
    readonly code: "task_not_found" | "task_not_executable",
    message: string,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

export type ExecutionResult = {
  actionId: string;
  result: AgentWorkResult;
};

export type ExecutionMission = {
  task: TaskRecord;
  results: ExecutionResult[];
};

const emptyRepositoryContext: RepositoryContextLoader = async () => [];

export class MissionExecutor {
  private readonly control: MissionControl;

  constructor(
    private readonly taskStore: TaskStore,
    private readonly runStore: AgentRunStore,
    private readonly worker: WorkerFn = runAnalysisWorker,
    private readonly modelName: string = executionModelName(),
    private readonly repositoryContext: RepositoryContextLoader = emptyRepositoryContext,
  ) {
    this.control = new MissionControl(taskStore);
  }

  async execute(taskId: string): Promise<ExecutionMission> {
    let task = await this.taskStore.get(taskId);
    if (!task) {
      throw new ExecutionError("task_not_found", `Task not found: ${taskId}`);
    }
    if (task.status !== "planned") {
      throw new ExecutionError(
        "task_not_executable",
        `Task must be planned before execution: ${task.status}`,
      );
    }

    task = await this.control.transition(
      task.id,
      "executing",
      "mission_control",
      "Autonomous execution started",
    );

    const results: ExecutionResult[] = [];

    for (const action of task.plan) {
      if (action.kind !== "analyze") {
        task = await this.control.transition(
          task.id,
          "human_required",
          "execution_engine",
          `Tool adapter not connected for ${action.kind}`,
        );
        return { task, results };
      }

      const runRecord = await this.runStore.start({
        taskId: task.id,
        agentRole: task.assignedAgent,
        model: this.modelName,
        payload: {
          actionId: action.id,
          kind: action.kind,
          target: action.target,
        },
      });

      try {
        const context = task.projectId
          ? await this.repositoryContext(task, action)
          : [];
        const result = await this.worker(task, action, context);
        await this.runStore.finish(runRecord.id, "succeeded", result);
        results.push({ actionId: action.id, result });

        if (result.requiresHuman) {
          task = await this.control.transition(
            task.id,
            "human_required",
            task.assignedAgent,
            "Worker requested human review",
          );
          return { task, results };
        }
      } catch {
        await this.runStore.finish(runRecord.id, "failed", {
          error: "worker_failed",
        });
        task = await this.control.transition(
          task.id,
          "failed",
          "execution_engine",
          "Worker execution failed",
        );
        return { task, results };
      }
    }

    task = await this.control.transition(
      task.id,
      "verifying",
      "execution_engine",
      "All supported actions executed",
    );
    task = await this.control.transition(
      task.id,
      "completed",
      "execution_engine",
      "Analysis-only mission verified",
    );

    return { task, results };
  }
}
