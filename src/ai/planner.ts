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

function isNoOpActionSummary(summary: string): boolean {
  const normalized = summary.trim().replace(/\s+/g, " ");
  return NO_OP_ACTION_SUMMARY.some((pattern) => pattern.test(normalized));
}

export function sanitizeMissionPlan(plan: MissionPlan): MissionPlan {
  const actions = plan.actions.filter((action) => !isNoOpActionSummary(action.summary));
  if (actions.length === 0) {
    throw new Error("Planner returned no executable actions");
  }
  return { ...plan, actions };
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
    ].join(" "),
    outputType: MissionPlanSchema,
  });

  const result = await run(planner, request);
  return sanitizeMissionPlan(MissionPlanSchema.parse(result.finalOutput));
}
