import type { MissionPlan } from "../ai/planner.js";
import type { TaskRecord, TaskStatus } from "../contracts/task.js";
import { MissionControl } from "../mission-control/mission-control.js";
import type { TaskStore } from "../store/task-store.js";

export type AutopilotInput =
  | { request: string; projectId?: string }
  | { taskId: string };

export type AutopilotNextAction =
  | "done"
  | "call_again"
  | "human_approval"
  | "human_review";

export type AutopilotResult = {
  task: TaskRecord;
  steps: number;
  nextAction: AutopilotNextAction;
};

export type AutopilotPlanner = (request: string) => Promise<MissionPlan>;
export type AutopilotExecutor = (taskId: string) => Promise<{ task: TaskRecord }>;
export type AutopilotMonitor = (taskId: string) => Promise<{ task: TaskRecord }>;

export class AutopilotError extends Error {
  constructor(
    readonly code: "task_not_found" | "unsafe_resume",
    message: string,
  ) {
    super(message);
    this.name = "AutopilotError";
  }
}

const MAX_STEPS_PER_CALL = 3;

function titleFromRequest(request: string): string {
  const firstLine = request.split("\n")[0]?.trim() || "Software factory task";
  return firstLine.slice(0, 160);
}

function nextAction(status: TaskStatus): AutopilotNextAction {
  if (status === "completed") return "done";
  if (status === "awaiting_approval") return "human_approval";
  if (
    status === "human_required"
    || status === "failed"
    || status === "rolled_back"
    || status === "verifying"
    || status === "staging"
  ) return "human_review";
  return "call_again";
}

function isApprovedProductionResume(task: TaskRecord): boolean {
  return task.status === "executing"
    && task.plan.length === 1
    && task.plan[0]?.kind === "deploy_production";
}

export class FactoryAutopilot {
  private readonly control: MissionControl;

  constructor(
    private readonly tasks: TaskStore,
    private readonly planner: AutopilotPlanner,
    private readonly executor: AutopilotExecutor,
    private readonly monitor: AutopilotMonitor,
  ) {
    this.control = new MissionControl(tasks);
  }

  async run(input: AutopilotInput): Promise<AutopilotResult> {
    let task: TaskRecord;

    if ("taskId" in input) {
      const existing = await this.tasks.get(input.taskId);
      if (!existing) {
        throw new AutopilotError("task_not_found", "Task not found: " + input.taskId);
      }
      task = existing;
    } else {
      task = await this.control.intake({
        title: titleFromRequest(input.request),
        description: input.request,
        requestedBy: "Abu",
        projectId: input.projectId,
      });
    }

    let steps = 0;
    while (steps < MAX_STEPS_PER_CALL) {
      if (task.status === "triaged") {
        const plan = await this.planner(task.description);
        task = await this.control.addPlan(
          task.id,
          plan.actions.map((action, index) => ({
            ...action,
            id: String(index + 1) + "-" + action.kind,
          })),
        );
        steps += 1;
        continue;
      }

      if (task.status === "planned" || isApprovedProductionResume(task)) {
        task = (await this.executor(task.id)).task;
        steps += 1;
        continue;
      }

      if (task.status === "deploying" || task.status === "monitoring") {
        task = (await this.monitor(task.id)).task;
        steps += 1;
        return { task, steps, nextAction: nextAction(task.status) };
      }

      if (task.status === "executing") {
        throw new AutopilotError(
          "unsafe_resume",
          "Only SHA-bound approved production execution may resume autonomously",
        );
      }

      return { task, steps, nextAction: nextAction(task.status) };
    }

    return { task, steps, nextAction: nextAction(task.status) };
  }
}
