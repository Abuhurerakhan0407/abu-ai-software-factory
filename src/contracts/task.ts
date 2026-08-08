import { z } from "zod";

export const TaskCategorySchema = z.enum([
  "feature",
  "bug",
  "docs",
  "security",
  "database",
  "deployment",
  "incident",
  "other",
]);

export const AgentRoleSchema = z.enum([
  "mission_control",
  "product_architect",
  "engineer",
  "qa_security",
  "sre",
]);

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

export const TaskStatusSchema = z.enum([
  "received",
  "triaged",
  "planned",
  "awaiting_approval",
  "executing",
  "verifying",
  "staging",
  "deploying",
  "monitoring",
  "completed",
  "failed",
  "rolled_back",
  "human_required",
]);

export const ActionKindSchema = z.enum([
  "analyze",
  "modify_code",
  "run_tests",
  "migrate_staging_db",
  "read_production_db",
  "deploy_production",
  "write_production_db",
  "delete_production_data",
  "change_auth",
  "change_billing",
  "access_raw_secret",
  "rollback",
]);

export const TaskInputSchema = z.object({
  title: z.string().min(3).max(160),
  description: z.string().min(3).max(10_000),
  requestedBy: z.string().min(1).max(120).default("Abu"),
  category: TaskCategorySchema.optional(),
  projectId: z.string().uuid().optional(),
});

export const PlannedActionSchema = z.object({
  id: z.string().min(1),
  kind: ActionKindSchema,
  summary: z.string().min(3).max(500),
  expectedContent: z.string().max(10_000).nullable().optional(),
  target: z.string().min(1).max(500),
  reversible: z.boolean(),
});

export const AuditEventSchema = z.object({
  at: z.string().datetime(),
  actor: z.string().min(1),
  event: z.string().min(1),
  detail: z.string().min(1),
});

export const TaskRecordSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  requestedBy: z.string(),
  projectId: z.string().uuid().nullable().optional(),
  category: TaskCategorySchema,
  assignedAgent: AgentRoleSchema,
  risk: RiskLevelSchema,
  status: TaskStatusSchema,
  plan: z.array(PlannedActionSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  audit: z.array(AuditEventSchema),
});

export type TaskCategory = z.infer<typeof TaskCategorySchema>;
export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type ActionKind = z.infer<typeof ActionKindSchema>;
export type TaskInput = z.infer<typeof TaskInputSchema>;
export type PlannedAction = z.infer<typeof PlannedActionSchema>;
export type TaskRecord = z.infer<typeof TaskRecordSchema>;
