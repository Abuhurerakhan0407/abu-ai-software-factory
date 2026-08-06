import { Agent, run } from "@openai/agents";
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

export async function createMissionPlan(request: string): Promise<MissionPlan> {
  const planner = new Agent({
    name: "Mission Control Planner",
    model: process.env.MISSION_CONTROL_MODEL ?? "gpt-5.6-luna",
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
