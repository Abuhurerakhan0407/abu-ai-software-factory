import { Codex, type ThreadOptions } from "@openai/codex-sdk";
import {
  EngineeringJobSchema,
  EngineeringResultSchema,
  type EngineeringJob,
  type EngineeringResult,
  type EngineeringWorker,
} from "./contracts.js";

export function buildCodexThreadOptions(job: EngineeringJob): ThreadOptions {
  return {
    model: process.env.ENGINEERING_MODEL ?? "gpt-5.6-sol",
    workingDirectory: job.workspacePath,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    skipGitRepoCheck: false,
  };
}

export function buildEngineeringPrompt(job: EngineeringJob): string {
  const criteria = job.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n");
  const checks = job.verificationCommands
    .map((command) => command.join(" "))
    .map((command) => `- ${command}`)
    .join("\n");

  return [
    "You are an engineering worker inside Abu AI Software Factory.",
    "Inspect the repository before editing. Work only inside the provided workspace.",
    "Never access production systems, raw secrets, billing, authentication providers, or external networks.",
    "Do not bypass tests, policy gates, or security checks.",
    "Prefer minimal reversible changes. Do not commit or push; Mission Control owns release flow.",
    "",
    `TASK:\n${job.instruction}`,
    "",
    `ACCEPTANCE CRITERIA:\n${criteria}`,
    "",
    checks ? `EXPECTED VERIFICATION:\n${checks}` : "EXPECTED VERIFICATION:\nUse repository-defined checks.",
    "",
    "Finish with a concise summary of files changed, checks run, and any remaining risk.",
  ].join("\n");
}

export class CodexEngineeringWorker implements EngineeringWorker {
  constructor(private readonly codex = new Codex()) {}

  async execute(rawJob: EngineeringJob): Promise<EngineeringResult> {
    const job = EngineeringJobSchema.parse(rawJob);
    const thread = this.codex.startThread(buildCodexThreadOptions(job));

    try {
      const result = await thread.run(buildEngineeringPrompt(job));
      return EngineeringResultSchema.parse({
        jobId: job.id,
        status: "completed",
        summary: result.finalResponse,
        workerThreadId: thread.id,
      });
    } catch (error) {
      return EngineeringResultSchema.parse({
        jobId: job.id,
        status: "failed",
        summary: error instanceof Error ? error.message : "Unknown Codex worker failure",
        workerThreadId: thread.id,
      });
    }
  }
}
