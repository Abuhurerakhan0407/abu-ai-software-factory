import { createMissionPlan, type MissionPlan } from "../ai/planner.js";
import type { TaskRecord } from "../contracts/task.js";
import { MissionControl } from "./mission-control.js";
import type { TaskStore } from "../store/task-store.js";

export type MissionPlanner = (request: string) => Promise<MissionPlan>;
export type OrchestrationGate = "ready" | "approval_required" | "human_required";

export class OrchestrationError extends Error {
  constructor(
    readonly code: "task_not_found" | "task_not_ready",
    message: string,
  ) {
    super(message);
    this.name = "OrchestrationError";
  }
}

export type PreparedMission = {
  summary: string;
  gate: OrchestrationGate;
  task: TaskRecord;
};

function gateForTask(task: TaskRecord): OrchestrationGate {
  if (task.status === "awaiting_approval") return "approval_required";
  if (task.status === "human_required") return "human_required";
  return "ready";
}

function plannerRequest(task: TaskRecord): string {
  return [
    "Prepare an execution plan for this already-triaged software task.",
    `Title: ${task.title}`,
    `Category: ${task.category}`,
    `Assigned agent: ${task.assignedAgent}`,
    `Current risk: ${task.risk}`,
    `Description: ${task.description}`,
  ].join("\n");
}

export class MissionOrchestrator {
  private readonly control: MissionControl;

  constructor(
    private readonly store: TaskStore,
    private readonly planner: MissionPlanner = createMissionPlan,
  ) {
    this.control = new MissionControl(store);
  }

  async prepare(taskId: string): Promise<PreparedMission> {
    const task = await this.store.get(taskId);
    if (!task) {
      throw new OrchestrationError("task_not_found", `Task not found: ${taskId}`);
    }
    if (task.status !== "triaged") {
      throw new OrchestrationError(
        "task_not_ready",
        `Task must be triaged before orchestration: ${task.status}`,
      );
    }

    const plan = await this.planner(plannerRequest(task));
    const actions = plan.actions.map((action, index) => ({
      id: `step-${index + 1}`,
      ...action,
    }));
    const updated = await this.control.addPlan(task.id, actions);

    return {
      summary: plan.summary,
      gate: gateForTask(updated),
      task: updated,
    };
  }
}
