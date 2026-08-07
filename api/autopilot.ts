import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createMissionPlan } from "../src/ai/planner.js";
import {
  AutopilotError,
  FactoryAutopilot,
} from "../src/autopilot/factory-autopilot.js";
import { StagingDatabaseGate } from "../src/database/staging-database-gate.js";
import { ProductionDeploymentGate } from "../src/deployment/production-deployment-gate.js";
import { ProductionMonitor } from "../src/deployment/production-monitor.js";
import { VerifiedCodePublisher } from "../src/execution/verified-code-publisher.js";
import { SafeCodePublisher } from "../src/github/safe-code-publisher.js";
import { SafeRepositoryNavigator } from "../src/github/safe-repository-navigator.js";
import { SafeRepositoryReader } from "../src/github/safe-repository-reader.js";
import { SourceAwareRepositoryContext } from "../src/github/source-context.js";
import { MissionExecutor } from "../src/mission-control/executor.js";
import { getProductionAgentRunStore } from "../src/store/postgres-agent-run-store.js";
import { getProductionProjectStore } from "../src/store/postgres-project-store.js";
import { getProductionTaskStore } from "../src/store/postgres-task-store.js";

const AutopilotRequestSchema = z.union([
  z.object({
    request: z.string().trim().min(3).max(10_000),
    projectId: z.string().uuid().optional(),
  }),
  z.object({
    taskId: z.string().uuid(),
  }),
]);

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function authorized(request: Request, expected: string): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

export async function POST(request: Request): Promise<Response> {
  const factoryToken = process.env.FACTORY_API_TOKEN;
  if (!factoryToken) return json({ error: "service_not_configured" }, 503);
  if (!authorized(request, factoryToken)) return json({ error: "unauthorized" }, 401);
  if (!process.env.DATABASE_URL) return json({ error: "database_not_configured" }, 503);

  let payload: z.infer<typeof AutopilotRequestSchema>;
  try {
    payload = AutopilotRequestSchema.parse(await request.json());
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  try {
    const tasks = getProductionTaskStore();
    const projects = getProductionProjectStore();
    const repositoryReader = new SafeRepositoryReader(projects);
    const repositoryContext = new SourceAwareRepositoryContext(
      repositoryReader,
      new SafeRepositoryNavigator(projects),
    );
    const codePublisher = new VerifiedCodePublisher(new SafeCodePublisher(projects));
    const stagingDatabase = new StagingDatabaseGate(projects);
    const productionDeployment = new ProductionDeploymentGate(projects);
    const executor = new MissionExecutor(
      tasks,
      getProductionAgentRunStore(),
      undefined,
      undefined,
      (task, action) => repositoryContext.load(task, action),
      undefined,
      (task, action, work) => codePublisher.publish(task, action, work),
      undefined,
      (task, action, work) => stagingDatabase.apply(task, action, work),
      (task, action) => productionDeployment.deploy(task, action),
    );
    const monitor = new ProductionMonitor(tasks, projects);
    const autopilot = new FactoryAutopilot(
      tasks,
      createMissionPlan,
      (taskId) => executor.execute(taskId),
      (taskId) => monitor.monitor(taskId),
    );

    const result = await autopilot.run(payload);
    return json({ ok: true, result });
  } catch (error) {
    if (error instanceof AutopilotError) {
      return json(
        { error: error.code },
        error.code === "task_not_found" ? 404 : 409,
      );
    }
    return json({ error: "autopilot_failed" }, 502);
  }
}
