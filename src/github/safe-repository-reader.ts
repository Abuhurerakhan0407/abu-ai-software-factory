import { z } from "zod";
import type { ProjectStore } from "../store/project-store.js";
import {
  getProductionGitHubGateway,
  type GitHubFile,
  type GitHubGateway,
} from "./github-gateway.js";

const MAX_REPOSITORY_FILE_BYTES = 256 * 1024;

const RepositoryPathSchema = z.string()
  .min(1)
  .max(500)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
    message: "Repository path must be relative and cannot traverse directories",
  })
  .refine((path) => {
    const name = path.split("/").at(-1)?.toLowerCase() ?? "";
    return !(
      name === ".env"
      || name.startsWith(".env.")
      || name === ".npmrc"
      || name === ".pypirc"
      || name === "credentials.json"
      || name.endsWith(".pem")
      || name.endsWith(".key")
      || name.endsWith(".p12")
      || name.endsWith(".pfx")
    );
  }, {
    message: "Sensitive repository paths cannot be read by agents",
  });

export const RepositoryReadInputSchema = z.object({
  projectId: z.string().uuid(),
  path: RepositoryPathSchema,
  ref: z.string().min(1).max(200).default("main"),
});

export type RepositoryReadInput = z.infer<typeof RepositoryReadInputSchema>;

export type RepositoryReadResult = {
  projectId: string;
  repository: string;
  path: string;
  ref: string;
  sha: string;
  content: string;
};

export class RepositoryReadError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "project_not_found"
      | "project_inactive"
      | "content_too_large",
    message: string,
  ) {
    super(message);
    this.name = "RepositoryReadError";
  }
}

type GatewayReader = Pick<GitHubGateway, "getFile">;
type GatewayFactory = (repository: string) => GatewayReader;

export class SafeRepositoryReader {
  constructor(
    private readonly projects: ProjectStore,
    private readonly gatewayFactory: GatewayFactory = getProductionGitHubGateway,
  ) {}

  async read(rawInput: RepositoryReadInput): Promise<RepositoryReadResult> {
    const parsed = RepositoryReadInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new RepositoryReadError("invalid_request", "Repository read request rejected");
    }

    const project = await this.projects.get(parsed.data.projectId);
    if (!project) {
      throw new RepositoryReadError("project_not_found", "Project not found");
    }
    if (project.status !== "active") {
      throw new RepositoryReadError("project_inactive", "Project is not active");
    }

    const file: GitHubFile = await this.gatewayFactory(project.repository)
      .getFile(parsed.data.path, parsed.data.ref);

    if (Buffer.byteLength(file.content, "utf8") > MAX_REPOSITORY_FILE_BYTES) {
      throw new RepositoryReadError(
        "content_too_large",
        "Repository file exceeds safe agent read limit",
      );
    }

    return {
      projectId: project.id,
      repository: project.repository,
      path: parsed.data.path,
      ref: parsed.data.ref,
      sha: file.sha,
      content: file.content,
    };
  }
}
