import { z } from "zod";
import type { PlannedAction, TaskRecord } from "../contracts/task.js";
import type { ProjectStore } from "../store/project-store.js";
import {
  getProductionGitHubGateway,
  type GitHubGateway,
  type ProductionPromotion,
} from "../github/github-gateway.js";

const DeploymentConfigSchema = z.object({
  provider: z.literal("vercel"),
  productionBranch: z.string().regex(/^[A-Za-z0-9._/-]{1,120}$/),
  vercelProjectId: z.string().regex(/^prj_[A-Za-z0-9]+$/),
});

const TargetSchema = z.string().regex(/^pull_request:[1-9][0-9]*$/);

export type ProductionDeploymentResult = {
  triggered: true;
  provider: "vercel";
  vercelProjectId: string;
  pullRequest: number;
  sourceHeadSha: string;
  productionCommitSha: string;
};

export class ProductionDeploymentGateError extends Error {
  constructor(
    readonly code:
      | "project_required"
      | "project_not_found"
      | "project_inactive"
      | "deployment_not_configured"
      | "approval_required"
      | "invalid_target"
      | "promotion_rejected",
    message: string,
  ) {
    super(message);
    this.name = "ProductionDeploymentGateError";
  }
}

type GatewayPromoter = Pick<GitHubGateway, "promoteVerifiedFactoryPullRequest">;
type GatewayFactory = (repository: string) => GatewayPromoter;

function hasExplicitHumanApproval(task: TaskRecord): boolean {
  return task.audit.some((event) =>
    event.actor === "Abu"
    && event.event === "status_changed"
    && event.detail.includes("awaiting_approval -> executing: Human approval granted")
  );
}

export class ProductionDeploymentGate {
  constructor(
    private readonly projects: ProjectStore,
    private readonly gatewayFactory: GatewayFactory = getProductionGitHubGateway,
  ) {}

  async deploy(
    task: TaskRecord,
    action: PlannedAction,
  ): Promise<ProductionDeploymentResult> {
    if (!task.projectId || action.kind !== "deploy_production") {
      throw new ProductionDeploymentGateError(
        "project_required",
        "Production deployment requires a registered project",
      );
    }
    if (task.status !== "executing" || !hasExplicitHumanApproval(task)) {
      throw new ProductionDeploymentGateError(
        "approval_required",
        "Explicit Abu approval is required before production deployment",
      );
    }

    const target = TargetSchema.safeParse(action.target);
    if (!target.success) {
      throw new ProductionDeploymentGateError(
        "invalid_target",
        "Production target must be pull_request:<number>",
      );
    }
    const pullRequest = Number(target.data.slice("pull_request:".length));

    const project = await this.projects.get(task.projectId);
    if (!project) {
      throw new ProductionDeploymentGateError("project_not_found", "Project not found");
    }
    if (project.status !== "active") {
      throw new ProductionDeploymentGateError("project_inactive", "Project is not active");
    }

    const config = DeploymentConfigSchema.safeParse(project.config.deployment);
    if (!config.success) {
      throw new ProductionDeploymentGateError(
        "deployment_not_configured",
        "Vercel production deployment mapping is required",
      );
    }

    let promoted: ProductionPromotion;
    try {
      promoted = await this.gatewayFactory(project.repository)
        .promoteVerifiedFactoryPullRequest({
          pullRequest,
          productionBranch: config.data.productionBranch,
        });
    } catch {
      throw new ProductionDeploymentGateError(
        "promotion_rejected",
        "Verified production promotion was rejected",
      );
    }

    return {
      triggered: true,
      provider: "vercel",
      vercelProjectId: config.data.vercelProjectId,
      pullRequest: promoted.pullRequest,
      sourceHeadSha: promoted.sourceHeadSha,
      productionCommitSha: promoted.productionCommitSha,
    };
  }
}
