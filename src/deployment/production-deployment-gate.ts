import { z } from "zod";
import type { PlannedAction, TaskRecord } from "../contracts/task.js";
import type { ProjectStore } from "../store/project-store.js";
import {
  getProductionGitHubGateway,
  type GitHubGateway,
  type ProductionPromotion,
  type ProductionPromotionCandidate,
} from "../github/github-gateway.js";

const DeploymentConfigSchema = z.object({
  provider: z.literal("vercel"),
  productionBranch: z.string().regex(/^[A-Za-z0-9._/-]{1,120}$/),
  vercelProjectId: z.string().regex(/^prj_[A-Za-z0-9]+$/),
});

const ApprovalBindingSchema = z.object({
  pullRequest: z.number().int().positive(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/i),
});

const TargetSchema = z.string().regex(/^pull_request:[1-9][0-9]*$/);

export type ProductionApprovalBinding = z.infer<typeof ApprovalBindingSchema>;

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
      | "approval_stale"
      | "invalid_target"
      | "promotion_rejected",
    message: string,
  ) {
    super(message);
    this.name = "ProductionDeploymentGateError";
  }
}

type GatewayPromoter = Pick<
  GitHubGateway,
  "inspectVerifiedFactoryPullRequest" | "promoteVerifiedFactoryPullRequest"
>;
type GatewayFactory = (repository: string) => GatewayPromoter;

function targetPullRequest(action: PlannedAction): number {
  const target = TargetSchema.safeParse(action.target);
  if (!target.success) {
    throw new ProductionDeploymentGateError(
      "invalid_target",
      "Production target must be pull_request:<number>",
    );
  }
  return Number(target.data.slice("pull_request:".length));
}

function approvalBinding(task: TaskRecord): ProductionApprovalBinding {
  const event = [...task.audit].reverse().find((item) =>
    item.actor === "Abu" && item.event === "production_approval_granted"
  );
  if (!event) {
    throw new ProductionDeploymentGateError(
      "approval_required",
      "Explicit production approval is missing",
    );
  }
  try {
    return ApprovalBindingSchema.parse(JSON.parse(event.detail));
  } catch {
    throw new ProductionDeploymentGateError(
      "approval_required",
      "Production approval binding is invalid",
    );
  }
}

export class ProductionDeploymentGate {
  constructor(
    private readonly projects: ProjectStore,
    private readonly gatewayFactory: GatewayFactory = getProductionGitHubGateway,
  ) {}

  async inspectApprovalCandidate(
    task: TaskRecord,
    action: PlannedAction,
  ): Promise<ProductionPromotionCandidate> {
    if (!task.projectId || action.kind !== "deploy_production") {
      throw new ProductionDeploymentGateError(
        "project_required",
        "Production deployment requires a registered project",
      );
    }
    if (task.status !== "awaiting_approval") {
      throw new ProductionDeploymentGateError(
        "approval_required",
        "Task must be awaiting explicit production approval",
      );
    }

    const pullRequest = targetPullRequest(action);
    const { project, config } = await this.requireDeploymentProject(task);
    try {
      return await this.gatewayFactory(project.repository)
        .inspectVerifiedFactoryPullRequest({
          pullRequest,
          productionBranch: config.productionBranch,
        });
    } catch {
      throw new ProductionDeploymentGateError(
        "promotion_rejected",
        "Pull request has not passed verified human-ready policy",
      );
    }
  }

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
    if (task.status !== "executing") {
      throw new ProductionDeploymentGateError(
        "approval_required",
        "Production deployment requires approved execution state",
      );
    }

    const pullRequest = targetPullRequest(action);
    const approved = approvalBinding(task);
    if (approved.pullRequest !== pullRequest) {
      throw new ProductionDeploymentGateError(
        "approval_stale",
        "Human approval targets a different pull request",
      );
    }

    const { project, config } = await this.requireDeploymentProject(task);
    let promoted: ProductionPromotion;
    try {
      promoted = await this.gatewayFactory(project.repository)
        .promoteVerifiedFactoryPullRequest({
          pullRequest,
          productionBranch: config.productionBranch,
          expectedHeadSha: approved.headSha,
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
      vercelProjectId: config.vercelProjectId,
      pullRequest: promoted.pullRequest,
      sourceHeadSha: promoted.sourceHeadSha,
      productionCommitSha: promoted.productionCommitSha,
    };
  }

  private async requireDeploymentProject(task: TaskRecord) {
    const project = await this.projects.get(task.projectId!);
    if (!project) {
      throw new ProductionDeploymentGateError("project_not_found", "Project not found");
    }
    if (project.status !== "active") {
      throw new ProductionDeploymentGateError("project_inactive", "Project is not active");
    }
    const parsed = DeploymentConfigSchema.safeParse(project.config.deployment);
    if (!parsed.success) {
      throw new ProductionDeploymentGateError(
        "deployment_not_configured",
        "Vercel production deployment mapping is required",
      );
    }
    return { project, config: parsed.data };
  }
}
