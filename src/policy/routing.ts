import type { AgentRole, TaskCategory } from "../contracts/task.js";

const routes: Record<TaskCategory, AgentRole> = {
  feature: "product_architect",
  bug: "engineer",
  docs: "product_architect",
  security: "qa_security",
  database: "product_architect",
  deployment: "sre",
  incident: "sre",
  other: "mission_control",
};

export function routeTask(category: TaskCategory): AgentRole {
  return routes[category];
}

export function inferCategory(text: string): TaskCategory {
  const value = text.toLowerCase();

  if (/incident|outage|down|latency|500 error/.test(value)) return "incident";
  if (/security|vulnerab|permission|auth|secret/.test(value)) return "security";
  if (/database|schema|migration|postgres|sql/.test(value)) return "database";
  if (/deploy|release|production|rollback/.test(value)) return "deployment";
  if (/bug|broken|error|fix|crash/.test(value)) return "bug";
  if (/docs|documentation|readme/.test(value)) return "docs";
  if (/add|build|create|feature|implement/.test(value)) return "feature";
  return "other";
}
