import { z } from "zod";
import type { ProjectStore } from "../store/project-store.js";
import {
  getProductionGitHubGateway,
  type GitHubGateway,
  type GitHubTreeEntry,
} from "./github-gateway.js";

const MAX_TREE_ENTRIES = 2_000;

export const RepositoryTreeInputSchema = z.object({
  projectId: z.string().uuid(),
  ref: z.string().min(1).max(200).default("main"),
});

export type RepositoryTreeInput = z.infer<typeof RepositoryTreeInputSchema>;

export type RepositoryTreeResult = {
  projectId: string;
  repository: string;
  ref: string;
  entries: GitHubTreeEntry[];
};

export class RepositoryTreeError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "project_not_found"
      | "project_inactive"
      | "tree_truncated"
      | "tree_too_large",
    message: string,
  ) {
    super(message);
    this.name = "RepositoryTreeError";
  }
}

function isSensitivePath(path: string): boolean {
  return path.split("/").some((segment) => {
    const name = segment.toLowerCase();
    return name === ".env"
      || name.startsWith(".env.")
      || name === ".npmrc"
      || name === ".pypirc"
      || name === "credentials.json"
      || name.endsWith(".pem")
      || name.endsWith(".key")
      || name.endsWith(".p12")
      || name.endsWith(".pfx");
  });
}

type GatewayTreeReader = Pick<GitHubGateway, "listTree">;
type GatewayFactory = (repository: string) => GatewayTreeReader;

export class SafeRepositoryNavigator {
  constructor(
    private readonly projects: ProjectStore,
    private readonly gatewayFactory: GatewayFactory = getProductionGitHubGateway,
  ) {}

  async list(rawInput: RepositoryTreeInput): Promise<RepositoryTreeResult> {
    const parsed = RepositoryTreeInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new RepositoryTreeError("invalid_request", "Repository tree request rejected");
    }

    const project = await this.projects.get(parsed.data.projectId);
    if (!project) {
      throw new RepositoryTreeError("project_not_found", "Project not found");
    }
    if (project.status !== "active") {
      throw new RepositoryTreeError("project_inactive", "Project is not active");
    }

    const tree = await this.gatewayFactory(project.repository)
      .listTree(parsed.data.ref);

    if (tree.truncated) {
      throw new RepositoryTreeError(
        "tree_truncated",
        "GitHub returned an incomplete repository tree",
      );
    }

    const entries = tree.entries.filter((entry) => !isSensitivePath(entry.path));
    if (entries.length > MAX_TREE_ENTRIES) {
      throw new RepositoryTreeError(
        "tree_too_large",
        "Repository tree exceeds safe navigation limit",
      );
    }

    return {
      projectId: project.id,
      repository: project.repository,
      ref: parsed.data.ref,
      entries,
    };
  }
}
