import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ProductionDeploymentGate } from "../src/deployment/production-deployment-gate.js";
import { MissionControl } from "../src/mission-control/mission-control.js";
import { getProductionProjectStore } from "../src/store/postgres-project-store.js";
import { getProductionTaskStore } from "../src/store/postgres-task-store.js";

const ApproveRequestSchema = z.object({
  taskId: z.string().uuid(),
});

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function hasValidApprovalToken(request: Request, expected: string): boolean {
  const supplied = request.headers.get("x-factory-approval-token");
  if (!supplied) return false;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length
    && timingSafeEqual(suppliedBytes, expectedBytes);
}

export async function POST(request: Request): Promise<Response> {
  const approvalToken = process.env.FACTORY_APPROVAL_TOKEN;
  if (!approvalToken) return json({ error: "approval_service_not_configured" }, 503);
  if (!hasValidApprovalToken(request, approvalToken)) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!process.env.DATABASE_URL) return json({ error: "database_not_configured" }, 503);

  let payload: z.infer<typeof ApproveRequestSchema>;
  try {
    payload = ApproveRequestSchema.parse(await request.json());
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  try {
    const tasks = getProductionTaskStore();
    const task = await tasks.get(payload.taskId);
    if (
      !task
      || task.status !== "awaiting_approval"
      || task.plan.length !== 1
      || task.plan[0]?.kind !== "deploy_production"
    ) {
      return json({ error: "approval_rejected" }, 409);
    }

    const action = task.plan[0];
    const gate = new ProductionDeploymentGate(getProductionProjectStore());
    const candidate = await gate.inspectApprovalCandidate(task, action);
    const approved = await new MissionControl(tasks).approveProduction(
      task.id,
      {
        pullRequest: candidate.pullRequest,
        headSha: candidate.sourceHeadSha,
      },
      "Abu",
    );

    return json({
      ok: true,
      taskId: approved.id,
      status: approved.status,
      approvedPullRequest: candidate.pullRequest,
      approvedHeadSha: candidate.sourceHeadSha,
    });
  } catch {
    return json({ error: "approval_rejected" }, 409);
  }
}
