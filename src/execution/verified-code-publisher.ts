import {
  qaReviewBlocks,
  runQaSecurityReview,
  type QaReviewFile,
  type QaSecurityReview,
} from "../agents/qa-security-reviewer.js";
import {
  runRepairWorker,
  type RepairWorkResult,
} from "../agents/repair-worker.js";
import type { CodeWorkResult } from "../agents/code-worker.js";
import type { PlannedAction, TaskRecord } from "../contracts/task.js";

const MAX_REPAIR_ATTEMPTS = 2;
const MAX_FAILURE_DETAIL_CHARS = 500;

function verificationFailureMessage(verification: SandboxVerification): string {
  const failed = [...verification.checks].reverse()
    .find((check) => check.exitCode !== 0);
  if (!failed) return verification.summary;

  const detail = (failed.stderr.trim() || failed.stdout.trim())
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|gh[opsu]|vcp|vcs)_[A-Za-z0-9_-]{8,}\b/g, "[redacted-token]")
    .replace(/\s+/g, " ")
    .slice(0, MAX_FAILURE_DETAIL_CHARS);

  return detail
    ? verification.summary + ": " + detail
    : verification.summary;
}
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
type QaReviewer = (
  task: TaskRecord,
  action: PlannedAction,
  files: readonly QaReviewFile[],
  verification: SandboxVerification,
) => Promise<QaSecurityReview>;

export class VerifiedCodePublishError extends Error {
  constructor(
    readonly code: "sandbox_failed" | "repair_failed" | "qa_security_failed",
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
    private readonly qaReviewer: QaReviewer = runQaSecurityReview,
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
    let repairWork = work;
    let reviewFiles: QaReviewFile[] = work.changes.map((change) => ({
      path: change.path,
      content: change.content,
    }));

    while (
      !verification.passed
      && verification.repairable
      && repairAttempts < MAX_REPAIR_ATTEMPTS
    ) {
      const repair = await this.repairWorker(
        task,
        action,
        repairWork,
        verification,
      );
      if (repair.requiresHuman || repair.changes.length === 0) break;

      await this.publisher.applyRepair(task, staging, repair);
      repairAttempts += 1;
      const repaired = new Map(
        repair.changes.map((change) => [change.path, change.content]),
      );
      reviewFiles = reviewFiles.map((file) => ({
        path: file.path,
        content: repaired.get(file.path) ?? file.content,
      }));
      repairWork = {
        ...repairWork,
        summary: repair.summary,
        changes: repairWork.changes.map((change) => ({
          ...change,
          content: repaired.get(change.path) ?? change.content,
        })),
      };
      verification = await this.verifier.verify({
        repository: staging.repository,
        ref: staging.branch,
      });
    }

    if (!verification.passed) {
      throw new VerifiedCodePublishError(
        repairAttempts > 0 ? "repair_failed" : "sandbox_failed",
        verificationFailureMessage(verification),
      );
    }

    const qaReview = await this.qaReviewer(
      task,
      action,
      reviewFiles,
      verification,
    );
    if (qaReviewBlocks(qaReview)) {
      throw new VerifiedCodePublishError(
        "qa_security_failed",
        qaReview.summary,
      );
    }

    return this.publisher.openDraft(task, action, staging, {
      summary: verification.summary,
      checks: verification.checks.map((check) =>
        check.label + ": " + (check.exitCode === 0 ? "passed" : "failed")),
      repairAttempts,
      qaSecurity: {
        summary: qaReview.summary,
        findings: qaReview.findings.map((finding) =>
          finding.severity + " " + finding.category
          + (finding.path ? " " + finding.path : "")
          + ": " + finding.summary),
      },
    });
  }
}
