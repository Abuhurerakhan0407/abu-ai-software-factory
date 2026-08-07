import { z } from "zod";
import type { TaskRecord } from "../contracts/task.js";
import { MissionControl } from "../mission-control/mission-control.js";
import type { ProjectStore } from "../store/project-store.js";
import type { TaskStore } from "../store/task-store.js";

const DeploymentConfigSchema = z.object({
  provider: z.literal("vercel"),
  vercelProjectId: z.string().regex(/^prj_[A-Za-z0-9]+$/),
  healthPath: z.string().regex(/^\/[^\s]*$/).default("/api/health"),
});

const DeploymentBindingSchema = z.object({
  vercelProjectId: z.string().regex(/^prj_[A-Za-z0-9]+$/),
  pullRequest: z.number().int().positive(),
  sourceHeadSha: z.string().regex(/^[a-f0-9]{40}$/i),
  productionCommitSha: z.string().regex(/^[a-f0-9]{40}$/i),
});

export type ProductionObservation =
  | {
      status: "pending";
      deploymentId?: string;
      reason: string;
    }
  | {
      status: "failed";
      deploymentId?: string;
      reason: string;
    }
  | {
      status: "protected";
      deploymentId: string;
      reason: string;
    }
  | {
      status: "healthy";
      deploymentId: string;
      reason: string;
    }
  | {
      status: "unhealthy";
      deploymentId: string;
      rollbackDeploymentId?: string;
      reason: string;
    };

export type ProductionMonitorResult = {
  task: TaskRecord;
  observation: ProductionObservation;
  healthySamples: number;
  unhealthySamples: number;
  rollback: "none" | "completed" | "unsupported";
};

export interface ProductionMonitoringGateway {
  observe(input: {
    vercelProjectId: string;
    productionCommitSha: string;
    healthPath: string;
  }): Promise<ProductionObservation>;
  rollback(input: {
    vercelProjectId: string;
    deploymentId: string;
    reason: string;
  }): Promise<"completed" | "unsupported">;
}

const DeploymentSchema = z.object({
  uid: z.string().optional(),
  id: z.string().optional(),
  url: z.string().nullable().optional(),
  state: z.string(),
  created: z.number(),
  isRollbackCandidate: z.boolean().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
}).refine((item) => Boolean(item.uid || item.id), "Deployment ID is required");

const DeploymentListSchema = z.object({
  deployments: z.array(DeploymentSchema),
});

function authConfig(): { token: string; teamId: string } {
  const token = process.env.VERCEL_AUTOMATION_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!token || !teamId) {
    throw new Error("VERCEL_AUTOMATION_TOKEN and VERCEL_TEAM_ID are required");
  }
  return { token, teamId };
}

function deploymentId(item: z.infer<typeof DeploymentSchema>): string {
  return item.id ?? item.uid!;
}

export class VercelProductionMonitoringGateway implements ProductionMonitoringGateway {
  async observe(input: {
    vercelProjectId: string;
    productionCommitSha: string;
    healthPath: string;
  }): Promise<ProductionObservation> {
    const { token, teamId } = authConfig();
    const params = new URLSearchParams({
      projectId: input.vercelProjectId,
      target: "production",
      limit: "10",
      teamId,
    });
    const response = await fetch("https://api.vercel.com/v7/deployments?" + params, {
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error("Vercel deployment lookup failed: " + response.status);

    const parsed = DeploymentListSchema.parse(await response.json());
    const deployments = [...parsed.deployments].sort((a, b) => b.created - a.created);
    const current = deployments.find((item) =>
      item.meta?.githubCommitSha === input.productionCommitSha
    );
    if (!current) {
      return { status: "pending", reason: "Production deployment not visible yet" };
    }

    const currentId = deploymentId(current);
    if (["ERROR", "CANCELED", "BLOCKED"].includes(current.state)) {
      return {
        status: "failed",
        deploymentId: currentId,
        reason: "Vercel deployment state: " + current.state,
      };
    }
    if (current.state !== "READY" || !current.url) {
      return {
        status: "pending",
        deploymentId: currentId,
        reason: "Vercel deployment state: " + current.state,
      };
    }

    let health: Response;
    try {
      health = await fetch("https://" + current.url + input.healthPath, {
        method: "GET",
        headers: { "user-agent": "abu-ai-software-factory-monitor/1" },
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      const previous = deployments.find((item) =>
        item.created < current.created
        && item.state === "READY"
        && item.isRollbackCandidate === true
      );
      return {
        status: "unhealthy",
        deploymentId: currentId,
        rollbackDeploymentId: previous ? deploymentId(previous) : undefined,
        reason: "Health endpoint unreachable",
      };
    }

    if (health.status === 401 || health.status === 403) {
      return {
        status: "protected",
        deploymentId: currentId,
        reason: "Health endpoint requires deployment-protection access",
      };
    }
    if (health.ok) {
      return {
        status: "healthy",
        deploymentId: currentId,
        reason: "Health endpoint returned " + health.status,
      };
    }

    const previous = deployments.find((item) =>
      item.created < current.created
      && item.state === "READY"
      && item.isRollbackCandidate === true
    );
    return {
      status: "unhealthy",
      deploymentId: currentId,
      rollbackDeploymentId: previous ? deploymentId(previous) : undefined,
      reason: "Health endpoint returned " + health.status,
    };
  }

  async rollback(input: {
    vercelProjectId: string;
    deploymentId: string;
    reason: string;
  }): Promise<"completed" | "unsupported"> {
    const { token, teamId } = authConfig();
    const params = new URLSearchParams({
      teamId,
      description: input.reason.slice(0, 240),
    });
    const response = await fetch(
      "https://api.vercel.com/v1/projects/"
        + encodeURIComponent(input.vercelProjectId)
        + "/rollback/"
        + encodeURIComponent(input.deploymentId)
        + "?"
        + params,
      {
        method: "POST",
        headers: { authorization: "Bearer " + token },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (response.status === 402 || response.status === 403) return "unsupported";
    if (response.status !== 201 && !response.ok) {
      throw new Error("Vercel rollback failed: " + response.status);
    }
    return "completed";
  }
}

function bindingFromTask(task: TaskRecord) {
  const event = [...task.audit].reverse().find((item) =>
    item.event === "production_deployment_triggered"
  );
  if (!event) throw new Error("Production deployment binding is missing");
  return DeploymentBindingSchema.parse(JSON.parse(event.detail));
}

function observationStreak(
  task: TaskRecord,
  commitSha: string,
  healthy: boolean,
): number {
  let count = 0;
  for (let index = task.audit.length - 1; index >= 0; index -= 1) {
    const event = task.audit[index]!;
    if (event.event !== "production_health_observed") continue;
    try {
      const detail = JSON.parse(event.detail) as {
        productionCommitSha?: string;
        healthy?: boolean;
      };
      if (detail.productionCommitSha !== commitSha || detail.healthy !== healthy) break;
      count += 1;
    } catch {
      break;
    }
  }
  return count;
}

export class ProductionMonitor {
  private readonly control: MissionControl;

  constructor(
    private readonly tasks: TaskStore,
    private readonly projects: ProjectStore,
    private readonly gateway: ProductionMonitoringGateway = new VercelProductionMonitoringGateway(),
  ) {
    this.control = new MissionControl(tasks);
  }

  async monitor(taskId: string): Promise<ProductionMonitorResult> {
    let task = await this.tasks.get(taskId);
    if (!task) throw new Error("Task not found");
    if (task.status === "deploying") {
      task = await this.control.transition(
        task.id,
        "monitoring",
        "sre",
        "Production monitoring started",
      );
    } else if (task.status !== "monitoring") {
      throw new Error("Task must be deploying or monitoring");
    }

    const binding = bindingFromTask(task);
    const project = task.projectId ? await this.projects.get(task.projectId) : undefined;
    if (!project || project.status !== "active") throw new Error("Active project is required");
    const config = DeploymentConfigSchema.parse(project.config.deployment);
    if (config.vercelProjectId !== binding.vercelProjectId) {
      throw new Error("Deployment binding no longer matches project");
    }

    const observation = await this.gateway.observe({
      vercelProjectId: config.vercelProjectId,
      productionCommitSha: binding.productionCommitSha,
      healthPath: config.healthPath,
    });

    if (observation.status === "pending") {
      return {
        task,
        observation,
        healthySamples: 0,
        unhealthySamples: 0,
        rollback: "none",
      };
    }

    if (observation.status === "protected") {
      task = await this.control.transition(
        task.id,
        "human_required",
        "sre",
        observation.reason,
      );
      return {
        task,
        observation,
        healthySamples: 0,
        unhealthySamples: 0,
        rollback: "none",
      };
    }

    if (observation.status === "failed") {
      task = await this.control.recordProductionObservation(task.id, {
        productionCommitSha: binding.productionCommitSha,
        deploymentId: observation.deploymentId ?? "unknown",
        healthy: false,
        reason: observation.reason,
      });
      task = await this.control.transition(
        task.id,
        "failed",
        "sre",
        "Production build failed before health verification",
      );
      return {
        task,
        observation,
        healthySamples: 0,
        unhealthySamples: 1,
        rollback: "none",
      };
    }

    task = await this.control.recordProductionObservation(task.id, {
      productionCommitSha: binding.productionCommitSha,
      deploymentId: observation.deploymentId,
      healthy: observation.status === "healthy",
      reason: observation.reason,
    });

    const healthySamples = observationStreak(task, binding.productionCommitSha, true);
    const unhealthySamples = observationStreak(task, binding.productionCommitSha, false);

    if (observation.status === "healthy") {
      if (healthySamples >= 2) {
        task = await this.control.transition(
          task.id,
          "completed",
          "sre",
          "Production healthy across two consecutive observations",
        );
      }
      return { task, observation, healthySamples, unhealthySamples, rollback: "none" };
    }

    if (unhealthySamples < 3) {
      return { task, observation, healthySamples, unhealthySamples, rollback: "none" };
    }
    if (!observation.rollbackDeploymentId) {
      task = await this.control.transition(
        task.id,
        "human_required",
        "sre",
        "Production unhealthy; no verified rollback candidate",
      );
      return { task, observation, healthySamples, unhealthySamples, rollback: "none" };
    }

    const rollback = await this.gateway.rollback({
      vercelProjectId: config.vercelProjectId,
      deploymentId: observation.rollbackDeploymentId,
      reason: "Three consecutive production health failures",
    });
    if (rollback === "unsupported") {
      task = await this.control.transition(
        task.id,
        "human_required",
        "sre",
        "Automatic Vercel rollback unavailable on current plan or permissions",
      );
      return { task, observation, healthySamples, unhealthySamples, rollback };
    }

    task = await this.control.transition(
      task.id,
      "rolled_back",
      "sre",
      "Production traffic rolled back after three consecutive health failures",
    );
    return { task, observation, healthySamples, unhealthySamples, rollback };
  }
}
