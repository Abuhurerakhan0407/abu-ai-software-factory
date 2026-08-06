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
  ).min(1).max(20),
});

export type MissionPlan = z.infer<typeof MissionPlanSchema>;

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
    ].join(" "),
    outputType: MissionPlanSchema,
  });

  const result = await run(planner, request);
  return MissionPlanSchema.parse(result.finalOutput);
}
