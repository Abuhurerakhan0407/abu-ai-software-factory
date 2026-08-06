import type { ActionKind, PlannedAction, RiskLevel, TaskCategory } from "../contracts/task.js";

export type GateDecision = "auto_allowed" | "approval_required" | "blocked";

const riskRank: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const actionRisk: Record<ActionKind, RiskLevel> = {
  analyze: "low",
  run_tests: "low",
  rollback: "low",
  modify_code: "medium",
  migrate_staging_db: "medium",
  read_production_db: "high",
  deploy_production: "high",
  write_production_db: "high",
  delete_production_data: "critical",
  change_auth: "critical",
  change_billing: "critical",
  access_raw_secret: "critical",
};

const categoryRisk: Record<TaskCategory, RiskLevel> = {
  docs: "low",
  feature: "medium",
  bug: "medium",
  other: "medium",
  database: "high",
  deployment: "high",
  incident: "high",
  security: "high",
};

export function initialRiskForCategory(category: TaskCategory): RiskLevel {
  return categoryRisk[category];
}

export function riskForAction(action: PlannedAction): RiskLevel {
  return actionRisk[action.kind];
}

export function gateForAction(action: PlannedAction): GateDecision {
  const risk = riskForAction(action);

  if (action.kind === "access_raw_secret") return "blocked";
  if (risk === "critical") return "approval_required";
  if (risk === "high") return "approval_required";
  return "auto_allowed";
}

export function highestRisk(base: RiskLevel, actions: PlannedAction[]): RiskLevel {
  return actions.reduce<RiskLevel>((highest, action) => {
    const candidate = riskForAction(action);
    return riskRank[candidate] > riskRank[highest] ? candidate : highest;
  }, base);
}
