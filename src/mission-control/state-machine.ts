import type { TaskStatus } from "../contracts/task.js";

const allowed: Record<TaskStatus, readonly TaskStatus[]> = {
  received: ["triaged", "failed", "human_required"],
  triaged: ["planned", "failed", "human_required"],
  planned: ["awaiting_approval", "executing", "failed", "human_required"],
  awaiting_approval: ["executing", "failed", "human_required"],
  executing: ["verifying", "failed", "human_required"],
  verifying: ["staging", "completed", "failed", "human_required"],
  staging: ["deploying", "completed", "failed", "human_required"],
  deploying: ["monitoring", "failed", "rolled_back", "human_required"],
  monitoring: ["completed", "failed", "rolled_back", "human_required"],
  completed: [],
  failed: ["planned", "rolled_back", "human_required"],
  rolled_back: ["planned", "completed", "human_required"],
  human_required: ["planned", "failed"],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return allowed[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal task transition: ${from} -> ${to}`);
  }
}
