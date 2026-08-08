import { Agent, run } from "@openai/agents";
import { OpenAIProvider } from "@openai/agents-openai";
import { z } from "zod";
import { ActionKindSchema, TaskCategorySchema } from "../contracts/task.js";

export const MissionPlanSchema = z.object({
  summary: z.string().min(3).max(600),
  category: TaskCategorySchema,
  actions: z.array(
    z.object({
      kind: ActionKindSchema,
      summary: z.string().min(3).max(500),
      expectedContent: z.string().max(10_000).nullable().describe(
        "Literal full file content when the request explicitly specifies exact content; otherwise null.",
      ),
      target: z.string().min(1).max(500),
      reversible: z.boolean(),
    }),
  )
    .min(1)
    .max(20)
    .describe(
      "Only actions that will actually execute. Omit negated, hypothetical, or no-op actions such as 'No billing changes required'.",
    ),
});

export type MissionPlan = z.infer<typeof MissionPlanSchema>;

const NO_OP_ACTION_SUMMARY = [
  /^no\s+.+\s+(?:required|needed|necessary|planned|requested|performed)\.?$/i,
  /^(?:none|nothing)\s+(?:required|needed|necessary|to do)\.?$/i,
];

const REPOSITORY_FILE_TARGET = /^(?:\.github|api|docs|migrations|src|tests)\//i;

const PLANNER_MAX_ATTEMPTS = 3;

function isNoOpActionSummary(summary: string): boolean {
  const normalized = summary.trim().replace(/\s+/g, " ");
  return NO_OP_ACTION_SUMMARY.some((pattern) => pattern.test(normalized));
}

function assertActionTargetCompatibility(action: MissionPlan["actions"][number]): void {
  const target = action.target.trim().replace(/\\/g, "/");
  const isRepositoryFile = REPOSITORY_FILE_TARGET.test(target);
  const isDatabaseAction = [
    "migrate_staging_db",
    "read_production_db",
    "write_production_db",
    "delete_production_data",
  ].includes(action.kind);

  if (isRepositoryFile && isDatabaseAction) {
    throw new Error(
      "Planner action kind/target mismatch: repository file changes must use modify_code",
    );
  }
}

export function sanitizeMissionPlan(plan: MissionPlan): MissionPlan {
  plan.actions.forEach(assertActionTargetCompatibility);
  const actions = plan.actions.filter((action) => !isNoOpActionSummary(action.summary));
  if (actions.length === 0) {
    throw new Error("Planner returned no executable actions");
  }
  return { ...plan, actions };
}

export async function retryPlannerOperation<T>(
  operation: () => Promise<T>,
  maxAttempts = PLANNER_MAX_ATTEMPTS,
): Promise<T> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Planner retry attempts must be a positive integer");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Planner failed without an error");
}

async function createPlannerModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is required for AI planning. Store it as a secret; never commit it.",
    );
  }

  const provider = new OpenAIProvider({
    apiKey,
    baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    useResponses: false,
  });

  return provider.getModel(process.env.MISSION_CONTROL_MODEL ?? "openrouter/free");
}

export async function createMissionPlan(request: string): Promise<MissionPlan> {
  const planner = new Agent({
    name: "Mission Control Planner",
    model: await createPlannerModel(),
    instructions: [
      "You convert software-company requests into small, auditable action plans.",
      "Never invent credentials or request raw secrets.",
      "Never hide production-impacting work inside a lower-risk action.",
      "Prefer reversible steps, staging, testing, and explicit targets.",
      "Use delete_production_data, change_auth, change_billing, or access_raw_secret only when truly required.",
      "Every action in actions means work that WILL execute. Omit negated, hypothetical, informational, or no-op actions.",
      "Never add an action whose summary says that the action is not required, not needed, or will not be performed.",
      "Repository file creation, edits, or deletion—including docs, source, tests, config, and workflow files—must use modify_code.",
      "When a repository-file request explicitly specifies exact literal full-file content, set expectedContent to only that literal content.",
      "Keep publication, testing, review, deployment, and workflow instructions out of expectedContent unless the user explicitly includes them in the literal file content.",
      "Set expectedContent to null when exact literal full-file content is not specified; always return this field.",
      "Never use database action kinds for repository files. write_production_db means changing live production database data, not files.",
    ].join(" "),
    outputType: MissionPlanSchema,
  });

  return retryPlannerOperation(async () => {
    const result = await run(planner, request);
    return sanitizeMissionPlan(MissionPlanSchema.parse(result.finalOutput));
  });
}
