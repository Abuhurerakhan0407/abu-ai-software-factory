import { randomUUID } from "node:crypto";
import {
  PlannedActionSchema,
  TaskInputSchema,
  type PlannedAction,
  type TaskInput,
  type TaskRecord,
  type TaskStatus,
} from "../contracts/task.js";
import { gateForAction, highestRisk, initialRiskForCategory } from "../policy/risk.js";
import { inferCategory, routeTask } from "../policy/routing.js";
import type { TaskStore } from "../store/task-store.js";
import { assertTransition } from "./state-machine.js";

export class MissionControl {
  constructor(private readonly store: TaskStore) {}

  async intake(raw: TaskInput): Promise<TaskRecord> {
    const input = TaskInputSchema.parse(raw);
    const now = new Date().toISOString();
    const category = input.category ?? inferCategory(`${input.title}\n${input.description}`);

    const task: TaskRecord = {
      id: randomUUID(),
      title: input.title,
      description: input.description,
      requestedBy: input.requestedBy,
      projectId: input.projectId ?? null,
      category,
      assignedAgent: routeTask(category),
      risk: initialRiskForCategory(category),
      status: "received",
      plan: [],
      createdAt: now,
      updatedAt: now,
      audit: [
        { at: now, actor: input.requestedBy, event: "task_received", detail: input.title },
      ],
    };

    await this.store.upsert(task);
    return this.transition(task.id, "triaged", "mission_control", `Routed to ${task.assignedAgent}`);
  }

  async addPlan(id: string, rawActions: PlannedAction[]): Promise<TaskRecord> {
    let task = await this.requireTask(id);
    if (task.status !== "triaged" && task.status !== "failed" && task.status !== "human_required") {
      throw new Error(`Cannot plan task from status: ${task.status}`);
    }

    const actions = PlannedActionSchema.array().min(1).parse(rawActions);
    const now = new Date().toISOString();
    task = {
      ...task,
      plan: actions,
      risk: highestRisk(task.risk, actions),
      updatedAt: now,
      audit: [...task.audit, { at: now, actor: "mission_control", event: "plan_added", detail: `${actions.length} actions` }],
    };
    await this.store.upsert(task);
    task = await this.transition(task.id, "planned", "mission_control", "Plan accepted by policy engine");

    const decisions = actions.map(gateForAction);
    if (decisions.includes("blocked")) {
      return this.transition(task.id, "human_required", "policy_engine", "Plan contains blocked action");
    }
    if (decisions.includes("approval_required")) {
      return this.transition(task.id, "awaiting_approval", "policy_engine", "High-risk action requires Abu approval");
    }
    return task;
  }

  async approve(id: string, actor = "Abu"): Promise<TaskRecord> {
    const task = await this.requireTask(id);
    if (task.status !== "awaiting_approval") {
      throw new Error(`Task is not awaiting approval: ${task.status}`);
    }
    return this.transition(id, "executing", actor, "Human approval granted");
  }

  async approveProduction(
    id: string,
    binding: { pullRequest: number; headSha: string },
    actor = "Abu",
  ): Promise<TaskRecord> {
    let task = await this.requireTask(id);
    if (actor !== "Abu" || task.status !== "awaiting_approval") {
      throw new Error("Production approval requires Abu and awaiting_approval state");
    }
    if (
      task.plan.length !== 1
      || task.plan[0]?.kind !== "deploy_production"
      || task.plan[0].target !== "pull_request:" + binding.pullRequest
      || !/^[a-f0-9]{40}$/i.test(binding.headSha)
    ) {
      throw new Error("Production approval binding does not match planned deployment");
    }

    const now = new Date().toISOString();
    task = {
      ...task,
      updatedAt: now,
      audit: [...task.audit, {
        at: now,
        actor,
        event: "production_approval_granted",
        detail: JSON.stringify({
          pullRequest: binding.pullRequest,
          headSha: binding.headSha,
        }),
      }],
    };
    await this.store.upsert(task);
    return this.transition(
      id,
      "executing",
      actor,
      "Human approval granted for verified PR head " + binding.headSha.slice(0, 12),
    );
  }

  async transition(id: string, next: TaskStatus, actor: string, reason: string): Promise<TaskRecord> {
    const task = await this.requireTask(id);
    assertTransition(task.status, next);
    const now = new Date().toISOString();
    const updated: TaskRecord = {
      ...task,
      status: next,
      updatedAt: now,
      audit: [...task.audit, { at: now, actor, event: "status_changed", detail: `${task.status} -> ${next}: ${reason}` }],
    };
    await this.store.upsert(updated);
    return updated;
  }

  private async requireTask(id: string): Promise<TaskRecord> {
    const task = await this.store.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }
}
