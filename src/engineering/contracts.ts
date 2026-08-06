import { z } from "zod";

export const EngineeringJobSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  workspacePath: z.string().min(1),
  instruction: z.string().min(3).max(20_000),
  acceptanceCriteria: z.array(z.string().min(1)).min(1).max(30),
  verificationCommands: z.array(z.array(z.string().min(1)).min(1)).max(20),
});

export const EngineeringResultSchema = z.object({
  jobId: z.string().uuid(),
  status: z.enum(["completed", "failed", "human_required"]),
  summary: z.string(),
  workerThreadId: z.string().optional(),
});

export type EngineeringJob = z.infer<typeof EngineeringJobSchema>;
export type EngineeringResult = z.infer<typeof EngineeringResultSchema>;

export interface EngineeringWorker {
  execute(job: EngineeringJob): Promise<EngineeringResult>;
}
