import {
  runRepairWorker,
  type RepairWorkResult,
} from "../agents/repair-worker.js";
import type { CodeWorkResult } from "../agents/code-worker.js";
import type { PlannedAction, TaskRecord } from "../contracts/task.js";
import {
  SafeCodePublisher,
  type CodePublication,
} from "../github/safe-code-publisher.js";
import {
  SandboxVerifier,
  type SandboxVerification,
} from "./sandbox-verifier.js";

type RepairWorker = (
  task: TaskRecord,
  action: PlannedAction,
  initialWork: CodeWorkResult,
  verification: SandboxVerification,
) => Promise<RepairWorkResult>;

type Verifier = Pick<SandboxVerifier, "verify">;

export class VerifiedCodePublishError extends Error {
  constructor(
    readonly code: "sandbox_failed" | "repair_failed",
    message: string,
  ) {
    super(message);
    this.name = "VerifiedCodePublishError";
  }
}

export class VerifiedCodePublisher {
  constructor(
    private readonly publisher: SafeCodePublisher,
    private readonly verifier: Verifier = new SandboxVerifier(),
    private readonly repairWorker: RepairWorker = runRepairWorker,
  ) {}

  async publish(
    task: TaskRecord,
    action: PlannedAction,
    work: CodeWorkResult,
  ): Promise<CodePublication> {
    const staging = await this.publisher.stage(task, action, work);
    let verification = await this.verifier.verify({
      repository: staging.repository,
      ref: staging.branch,
    });
    let repairAttempts = 0;

    if (!verification.passed && verification.repairable) {
      const repair = await this.repairWorker(task, action, work, verification);
      if (!repair.requiresHuman && repair.changes.length > 0) {
        await this.publisher.applyRepair(task, staging, repair);
        repairAttempts = 1;
        verification = await this.verifier.verify({
          repository: staging.repository,
          ref: staging.branch,
        });
      }
    }

    if (!verification.passed) {
      throw new VerifiedCodePublishError(
        repairAttempts > 0 ? "repair_failed" : "sandbox_failed",
        verification.summary,
      );
    }

    return this.publisher.openDraft(task, action, staging, {
      summary: verification.summary,
      checks: verification.checks.map((check) =>
        check.label + ": " + (check.exitCode === 0 ? "passed" : "failed")),
      repairAttempts,
    });
  }
}
