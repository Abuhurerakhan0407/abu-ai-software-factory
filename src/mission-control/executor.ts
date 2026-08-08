import type {
  PlannedAction,
  TaskRecord,
} from "../contracts/task.js";
import {
  runCodeWorker,
  type CodeWorkResult,
} from "../agents/code-worker.js";
import {
  runStagingMigrationWorker,
  type StagingMigrationWork,
} from "../agents/staging-migration-worker.js";
import type { StagingMigrationResult } from "../database/staging-database-gate.js";
import type { ProductionDeploymentResult } from "../deployment/production-deployment-gate.js";
import {
  executionModelName,
  runAnalysisWorker,
  type AgentWorkResult,
} from "../agents/role-worker.js";
import type {
  RepositoryContextFile,
  RepositoryContextLoader,
} from "../github/repository-context.js";
import type { CodePublication } from "../github/safe-code-publisher.js";
import type { AgentRunStore } from "../store/agent-run-store.js";
import type { TaskStore } from "../store/task-store.js";
import { MissionControl } from "./mission-control.js";

export type WorkerFn = (
  task: TaskRecord,
  action: PlannedAction,
  repositoryContext?: readonly RepositoryContextFile[],
) => Promise<AgentWorkResult>;

export type CodeWorkerFn = (
  task: TaskRecord,
  action: PlannedAction,
  repositoryContext: readonly RepositoryContextFile[],
) => Promise<CodeWorkResult>;

export type TestRunnerFn = (
  task: TaskRecord,
  action: PlannedAction,
) => Promise<AgentWorkResult>;

export type CodePublisherFn = (
  task: TaskRecord,
  action: PlannedAction,
  work: CodeWorkResult,
) => Promise<CodePublication>;

export type StagingMigrationWorkerFn = (
  task: TaskRecord,
  action: PlannedAction,
  repositoryContext: readonly RepositoryContextFile[],
) => Promise<StagingMigrationWork>;

export type StagingDatabaseFn = (
  task: TaskRecord,
  action: PlannedAction,
  work: StagingMigrationWork,
) => Promise<StagingMigrationResult>;

export type ProductionDeploymentFn = (
  task: TaskRecord,
  action: PlannedAction,
) => Promise<ProductionDeploymentResult>;

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

function safeWorkerFailure(error: unknown): {
  error: "worker_failed";
  errorName: string;
  errorMessage: string;
} {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const errorMessage = (error instanceof Error ? error.message : String(error))
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|gh[opsu]|vcp|vcs)_[A-Za-z0-9_-]{8,}\b/g, "[redacted-token]")
    .slice(0, 500);
  return { error: "worker_failed", errorName, errorMessage };
}

export class MissionExecutor {
  private readonly control: MissionControl;

  constructor(
    private readonly taskStore: TaskStore,
    private readonly runStore: AgentRunStore,
    private readonly worker: WorkerFn = runAnalysisWorker,
    private readonly modelName: string = executionModelName(),
    private readonly repositoryContext: RepositoryContextLoader = emptyRepositoryContext,
    private readonly codeWorker: CodeWorkerFn = runCodeWorker,
    private readonly codePublisher?: CodePublisherFn,
    private readonly stagingMigrationWorker: StagingMigrationWorkerFn = runStagingMigrationWorker,
    private readonly stagingDatabase?: StagingDatabaseFn,
    private readonly productionDeployment?: ProductionDeploymentFn,
    private readonly testRunner?: TestRunnerFn,
  ) {
    this.control = new MissionControl(taskStore);
  }

  async execute(taskId: string): Promise<ExecutionMission> {
    let task = await this.taskStore.get(taskId);
    if (!task) {
      throw new ExecutionError("task_not_found", "Task not found: " + taskId);
    }
    const resumingApprovedProduction = task.status === "executing"
      && task.plan.length === 1
      && task.plan[0]?.kind === "deploy_production";
    if (task.status !== "planned" && !resumingApprovedProduction) {
      throw new ExecutionError(
        "task_not_executable",
        "Task must be planned or explicitly approved for production: " + task.status,
      );
    }

    if (task.status === "planned") {
      task = await this.control.transition(
        task.id,
        "executing",
        "mission_control",
        "Autonomous execution started",
      );
    }

    const results: ExecutionResult[] = [];
    let usedStagingDatabase = false;

    for (const action of task.plan) {
      if (
        action.kind !== "analyze"
        && action.kind !== "run_tests"
        && action.kind !== "modify_code"
        && action.kind !== "migrate_staging_db"
        && action.kind !== "deploy_production"
      ) {
        task = await this.control.transition(
          task.id,
          "human_required",
          "execution_engine",
          "Tool adapter not connected for " + action.kind,
        );
        return { task, results };
      }

      if (action.kind === "run_tests" && !this.testRunner) {
        task = await this.control.transition(
          task.id,
          "human_required",
          "qa_security",
          "Sandbox test runner is unavailable",
        );
        return { task, results };
      }

      if (action.kind === "modify_code" && (!task.projectId || !this.codePublisher)) {
        task = await this.control.transition(
          task.id,
          "human_required",
          "execution_engine",
          "Safe code publisher is unavailable",
        );
        return { task, results };
      }

      if (action.kind === "migrate_staging_db" && (!task.projectId || !this.stagingDatabase)) {
        task = await this.control.transition(
          task.id,
          "human_required",
          "execution_engine",
          "Staging database gate is unavailable",
        );
        return { task, results };
      }

      if (action.kind === "deploy_production" && (!task.projectId || !this.productionDeployment)) {
        task = await this.control.transition(
          task.id,
          "human_required",
          "execution_engine",
          "Production deployment gate is unavailable",
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

        if (action.kind === "deploy_production") {
          const deployed = await this.productionDeployment!(task, action);
          const result: AgentWorkResult = {
            summary: "Verified production deployment triggered",
            evidence: [
              "Verified PR #" + deployed.pullRequest + " merged",
              "Approved source head: " + deployed.sourceHeadSha,
              "Production commit: " + deployed.productionCommitSha,
              "Vercel rollout awaiting monitoring",
            ],
            recommendations: ["Monitor production health before completion"],
            requiresHuman: false,
          };
          await this.runStore.finish(runRecord.id, "succeeded", result);
          results.push({ actionId: action.id, result });

          task = await this.control.recordProductionDeployment(task.id, {
            vercelProjectId: deployed.vercelProjectId,
            pullRequest: deployed.pullRequest,
            sourceHeadSha: deployed.sourceHeadSha,
            productionCommitSha: deployed.productionCommitSha,
          });
          task = await this.control.transition(
            task.id,
            "verifying",
            "qa_security",
            "SHA-bound production promotion accepted",
          );
          task = await this.control.transition(
            task.id,
            "staging",
            "qa_security",
            "Verified artifact promoted from reviewed factory PR",
          );
          task = await this.control.transition(
            task.id,
            "deploying",
            "sre",
            "Vercel production rollout triggered; monitoring required",
          );
          return { task, results };
        }

        if (action.kind === "run_tests") {
          const result = await this.testRunner!(task, action);
          await this.runStore.finish(runRecord.id, "succeeded", result);
          results.push({ actionId: action.id, result });

          if (result.requiresHuman) {
            task = await this.control.transition(
              task.id,
              "human_required",
              "qa_security",
              "Sandbox test runner requested human review",
            );
            return { task, results };
          }
          continue;
        }

        if (action.kind === "analyze") {
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
          continue;
        }

        if (action.kind === "migrate_staging_db") {
          const migration = await this.stagingMigrationWorker(task, action, context);
          if (migration.requiresHuman) {
            const result: AgentWorkResult = {
              summary: migration.summary,
              evidence: ["No database writes were performed"],
              recommendations: ["Human review is required for this migration"],
              requiresHuman: true,
            };
            await this.runStore.finish(runRecord.id, "succeeded", result);
            results.push({ actionId: action.id, result });
            task = await this.control.transition(
              task.id,
              "human_required",
              "qa_security",
              "Staging migration worker requested human review",
            );
            return { task, results };
          }

          const applied = await this.stagingDatabase!(task, action, migration);
          const result: AgentWorkResult = {
            summary: migration.summary,
            evidence: [
              "Staging migration fingerprint: " + applied.fingerprint,
              "Additive statements applied: " + applied.statements,
              "Production database untouched",
            ],
            recommendations: ["Verify application behavior against staging database"],
            requiresHuman: false,
          };
          await this.runStore.finish(runRecord.id, "succeeded", result);
          results.push({ actionId: action.id, result });
          usedStagingDatabase = true;
          continue;
        }

        const codeWork = await this.codeWorker(task, action, context);
        if (codeWork.requiresHuman) {
          const result: AgentWorkResult = {
            summary: codeWork.summary,
            evidence: ["No repository writes were performed"],
            recommendations: ["Human review is required before code publication"],
            requiresHuman: true,
          };
          await this.runStore.finish(runRecord.id, "succeeded", result);
          results.push({ actionId: action.id, result });
          task = await this.control.transition(
            task.id,
            "human_required",
            task.assignedAgent,
            "Code worker requested human review",
          );
          return { task, results };
        }

        const publication = await this.codePublisher!(task, action, codeWork);
        const result: AgentWorkResult = {
          summary: codeWork.summary,
          evidence: [
            "Draft PR #" + publication.pullRequest.number + ": " + publication.pullRequest.url,
            ...(publication.verification
              ? [
                  "Sandbox: " + publication.verification.summary,
                  ...publication.verification.checks,
                  "Repair attempts: " + publication.verification.repairAttempts,
                  ...(publication.verification.qaSecurity
                    ? [
                        "QA/security: " + publication.verification.qaSecurity.summary,
                        ...publication.verification.qaSecurity.findings,
                      ]
                    : []),
                ]
              : []),
            ...publication.files.map((path) => "Changed: " + path),
          ],
          recommendations: ["Review and verify the draft pull request before merge"],
          requiresHuman: true,
        };
        await this.runStore.finish(runRecord.id, "succeeded", result);
        results.push({ actionId: action.id, result });
        task = await this.control.transition(
          task.id,
          "human_required",
          "execution_engine",
          publication.verification
            ? "Sandbox-verified draft pull request created; human merge required"
            : "Draft pull request created; human merge required",
        );
        return { task, results };
      } catch (error) {
        await this.runStore.finish(
          runRecord.id,
          "failed",
          safeWorkerFailure(error),
        );
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
    if (usedStagingDatabase) {
      task = await this.control.transition(
        task.id,
        "staging",
        "qa_security",
        "Staging database migration passed guarded execution",
      );
    }

    task = await this.control.transition(
      task.id,
      "completed",
      "execution_engine",
      usedStagingDatabase
        ? "Staging migration verified; production database untouched"
        : "Analysis-only mission verified",
    );

    return { task, results };
  }
}
