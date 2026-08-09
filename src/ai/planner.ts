import { Agent, run } from "@openai/agents";
import { OpenAIProvider } from "@openai/agents-openai";
import { z } from "zod";
import {
  ActionKindSchema,
  TaskCategorySchema,
  type TaskCategory,
} from "../contracts/task.js";

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

type ParsedMissionPlan = z.infer<typeof MissionPlanSchema>;

export type MissionPlan = Omit<ParsedMissionPlan, "actions"> & {
  actions: Array<
    Omit<ParsedMissionPlan["actions"][number], "expectedContent">
    & { expectedContent?: string | null }
  >;
};

const NO_OP_ACTION_SUMMARY = [
  /^no\s+.+\s+(?:required|needed|necessary|planned|requested|performed)\.?$/i,
  /^(?:none|nothing)\s+(?:required|needed|necessary|to do)\.?$/i,
];

const REPOSITORY_FILE_TARGET = /^(?:\.github|api|docs|migrations|src|tests)\//i;

const PLANNER_MAX_ATTEMPTS = 3;
const PLANNER_ATTEMPT_TIMEOUT_MS = 60_000;

export class PlannerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Planner model call timed out after ${timeoutMs}ms`);
    this.name = "PlannerTimeoutError";
  }
}

export function isPlannerQuotaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const record = error as Record<string, unknown>;
  const status = record.status;
  const code = record.code;
  if (status === 429 || status === "429" || code === 429 || code === "429") {
    return true;
  }

  const message = error instanceof Error
    ? error.message
    : typeof record.message === "string"
      ? record.message
      : "";

  return /free-models-per-day|rate limit exceeded/i.test(message);
}

const PLANNER_CATEGORY_ALIASES: Readonly<Record<string, TaskCategory>> = {
  enhancement: "feature",
  code: "feature",
  test: "feature",
  tests: "feature",
  testing: "feature",
  qa: "feature",
  bugfix: "bug",
  fix: "bug",
  error: "bug",
  documentation: "docs",
  document: "docs",
  readme: "docs",
  auth: "security",
  authentication: "security",
  authorization: "security",
  secret: "security",
  secrets: "security",
  vulnerability: "security",
  db: "database",
  data: "database",
  migration: "database",
  deploy: "deployment",
  release: "deployment",
  production: "deployment",
  devops: "deployment",
  sre: "deployment",
  outage: "incident",
  emergency: "incident",
  rollback: "incident",
  analysis: "other",
  general: "other",
  maintenance: "other",
};

export function normalizePlannerCategory(value: unknown): TaskCategory {
  const normalized = typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
  const direct = TaskCategorySchema.safeParse(normalized);
  if (direct.success) return direct.data;
  return PLANNER_CATEGORY_ALIASES[normalized] ?? "other";
}

export function parseMissionPlanJson(output: string): MissionPlan {
  const trimmed = output.trim();
  const fenced = trimmed.match(
    /^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i,
  );
  const candidate = fenced?.[1] ?? trimmed;
  const decoded: unknown = JSON.parse(candidate);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return MissionPlanSchema.parse(decoded);
  }

  return MissionPlanSchema.parse({
    ...decoded,
    category: normalizePlannerCategory(
      (decoded as Record<string, unknown>).category,
    ),
  });
}

const EXACT_CONTENT_MARKER = /\b(?:containing exactly|(?:entire\s+)?file content must be exactly)\s*:?\s*/i;
const EXACT_CONTENT_CONTROL_BOUNDARY = /\s+(?=(?:publication requirement\s*:|publish changes?\b|do not (?:modify|change|deploy|commit|push|publish)\b))/i;

export function applyDeterministicExactContent(
  request: string,
  plan: MissionPlan,
): MissionPlan {
  const literalFreePlan: MissionPlan = {
    ...plan,
    actions: plan.actions.map((action) => ({
      ...action,
      expectedContent: null,
    })),
  };
  const marker = EXACT_CONTENT_MARKER.exec(request);
  if (!marker) return literalFreePlan;

  const codeActions = literalFreePlan.actions.filter(
    (action) => action.kind === "modify_code",
  );
  if (codeActions.length !== 1) return literalFreePlan;

  const remainder = request.slice(marker.index + marker[0].length).trimStart();
  if (!remainder) return literalFreePlan;

  let expectedContent: string;
  const quote = remainder[0];
  if (quote === "\"" || quote === "'" || quote === "`") {
    const closingQuote = remainder.indexOf(quote, 1);
    if (closingQuote < 1) return literalFreePlan;
    expectedContent = remainder.slice(1, closingQuote);
  } else {
    expectedContent = remainder.split(EXACT_CONTENT_CONTROL_BOUNDARY, 1)[0]?.trim() ?? "";
  }

  if (!expectedContent || expectedContent.length > 10_000) {
    return literalFreePlan;
  }

  return {
    ...literalFreePlan,
    actions: literalFreePlan.actions.map((action) => action === codeActions[0]
      ? { ...action, expectedContent }
      : action),
  };
}

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
      if (error instanceof PlannerTimeoutError || isPlannerQuotaError(error)) {
        throw error;
      }
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
  const model = await createPlannerModel();
  const instructions = [
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
  ].join(" ");
  const jsonInstructions = [
    instructions,
    "Return exactly one JSON object and nothing else.",
    "The object must have keys summary, category, actions.",
    "category must be exactly one of feature, bug, docs, security, database, deployment, incident, other.",
    "Each action must have kind, summary, expectedContent, target, reversible.",
    "expectedContent must be a JSON string or null. reversible must be a JSON boolean.",
    "Do not return Markdown, code fences, or prose outside the JSON object.",
  ].join(" ");
  const planner = new Agent({
    name: "Mission Control Planner",
    model,
    instructions: jsonInstructions,
  });

  return retryPlannerOperation(async () => {
    const signal = AbortSignal.timeout(PLANNER_ATTEMPT_TIMEOUT_MS);
    let result;
    try {
      result = await run(planner, request, { signal });
    } catch (error) {
      if (signal.aborted) {
        throw new PlannerTimeoutError(PLANNER_ATTEMPT_TIMEOUT_MS);
      }
      throw error;
    }

    if (typeof result.finalOutput !== "string") {
      throw new Error("Planner output was not text");
    }

    let parsed: MissionPlan;
    try {
      parsed = parseMissionPlanJson(result.finalOutput);
    } catch {
      const recoveryPlanner = new Agent({
        name: "Mission Control Planner JSON Recovery",
        model,
        instructions: [
          jsonInstructions,
          "Repair the supplied invalid output into valid JSON matching the required object shape.",
          "Return the repaired JSON object only.",
        ].join(" "),
      });
      let recovery;
      try {
        recovery = await run(
          recoveryPlanner,
          JSON.stringify({
            request,
            invalidOutput: result.finalOutput,
          }),
          { signal },
        );
      } catch (error) {
        if (signal.aborted) {
          throw new PlannerTimeoutError(PLANNER_ATTEMPT_TIMEOUT_MS);
        }
        throw error;
      }
      if (typeof recovery.finalOutput !== "string") {
        throw new Error("Planner recovery output was not text");
      }
      parsed = parseMissionPlanJson(recovery.finalOutput);
    }

    const sanitized = sanitizeMissionPlan(parsed);
    return applyDeterministicExactContent(request, sanitized);
  });
}
