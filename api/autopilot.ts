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
import { SandboxVerifier } from "../src/execution/sandbox-verifier.js";
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

  const startedAt = Date.now();
  const requestId = request.headers.get("x-vercel-id");
  console.log(
    JSON.stringify({
      level: "info",
      msg: "autopilot_start",
      route: "/api/autopilot",
      requestId,
    }),
  );

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
    const sandboxVerifier = new SandboxVerifier();
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
      async (task) => {
        const project = task.projectId
          ? await projects.get(task.projectId)
          : (await projects.list()).filter((candidate) => candidate.status === "active").at(0);
        const activeProjects = task.projectId
          ? project
            ? [project]
            : []
          : (await projects.list()).filter((candidate) => candidate.status === "active");

        if (!project || project.status !== "active" || activeProjects.length !== 1) {
          return {
            summary: "Sandbox tests need one unambiguous active project",
            evidence: [],
            recommendations: ["Select an active project before running tests"],
            requiresHuman: true,
          };
        }

        const verification = await sandboxVerifier.verify({
          repository: project.repository,
          ref: "main",
        });
        return {
          summary: verification.summary,
          evidence: verification.checks.map((check) =>
            check.label + ": " + (check.exitCode === 0 ? "passed" : "failed")),
          recommendations: verification.passed
            ? []
            : ["Review the failed isolated sandbox check"],
          requiresHuman: !verification.passed,
        };
      },
    );
    const monitor = new ProductionMonitor(tasks, projects);
    const autopilot = new FactoryAutopilot(
      tasks,
      createMissionPlan,
      (taskId) => executor.execute(taskId),
      (taskId) => monitor.monitor(taskId),
    );

    const result = await autopilot.run(payload);
    console.log(
      JSON.stringify({
        level: "info",
        msg: "autopilot_done",
        route: "/api/autopilot",
        requestId,
        ms: Date.now() - startedAt,
      }),
    );
    return json({ ok: true, result });
  } catch (error) {
    if (error instanceof AutopilotError) {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "autopilot_rejected",
          route: "/api/autopilot",
          requestId,
          code: error.code,
          ms: Date.now() - startedAt,
        }),
      );
      return json(
        { error: error.code },
        error.code === "task_not_found" ? 404 : 409,
      );
    }

    const errorName = error instanceof Error ? error.name : "UnknownError";
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;
    const errorMessage = (error instanceof Error ? error.message : String(error))
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-token]")
      .slice(0, 500);

    console.error(
      JSON.stringify({
        level: "error",
        msg: "autopilot_failed",
        route: "/api/autopilot",
        requestId,
        errorName,
        errorCode,
        errorMessage,
        ms: Date.now() - startedAt,
      }),
    );
    return json({ error: "autopilot_failed" }, 502);
  }
}
