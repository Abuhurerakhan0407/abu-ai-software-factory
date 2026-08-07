import { z } from "zod";
import type { PlannedAction, TaskRecord } from "../contracts/task.js";
import type { ProjectStore } from "../store/project-store.js";
import type { CodeWorkResult } from "../agents/code-worker.js";
import {
  getProductionGitHubGateway,
  type DraftPullRequest,
  type GitHubGateway,
  type GitHubTree,
} from "./github-gateway.js";
import { isSensitiveRepositoryPath } from "./repository-path-policy.js";

const MAX_CHANGED_FILES = 5;
const MAX_FILE_CHARS = 64_000;
const MAX_TOTAL_CHARS = 160_000;

const WRITABLE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".scss", ".html",
  ".py", ".go", ".rs", ".java", ".kt", ".php", ".rb",
  ".graphql", ".gql", ".json", ".md", ".yaml", ".yml",
] as const;

const BLOCKED_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

function isWritablePath(path: string): boolean {
  if (isSensitiveRepositoryPath(path)) return false;
  if (path.startsWith(".github/")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment.startsWith("."))) return false;
  const basename = segments.at(-1)?.toLowerCase() ?? "";
  if (BLOCKED_BASENAMES.has(basename)) return false;
  return WRITABLE_EXTENSIONS.some((extension) => basename.endsWith(extension));
}

const SafeChangeSchema = z.object({
  operation: z.enum(["create", "update"]),
  path: z.string()
    .min(1)
    .max(500)
    .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."))
    .refine(isWritablePath, "Path is outside autonomous code-write policy"),
  sourceSha: z.string().min(7).max(100).optional(),
  content: z.string().max(MAX_FILE_CHARS),
});

export class SafeCodePublishError extends Error {
  constructor(
    readonly code:
      | "project_required"
      | "project_not_found"
      | "project_inactive"
      | "invalid_change"
      | "duplicate_path"
      | "change_too_large"
      | "stale_source"
      | "create_conflict",
    message: string,
  ) {
    super(message);
    this.name = "SafeCodePublishError";
  }
}

export type CodePublication = {
  projectId: string;
  repository: string;
  branch: string;
  pullRequest: DraftPullRequest;
  files: string[];
};

type GatewayWriter = Pick<
  GitHubGateway,
  "createFactoryBranch" | "listTree" | "writeFile" | "openDraftPullRequest"
>;
type GatewayFactory = (repository: string) => GatewayWriter;

export class SafeCodePublisher {
  constructor(
    private readonly projects: ProjectStore,
    private readonly gatewayFactory: GatewayFactory = getProductionGitHubGateway,
  ) {}

  async publish(
    task: TaskRecord,
    action: PlannedAction,
    work: CodeWorkResult,
  ): Promise<CodePublication> {
    if (!task.projectId) {
      throw new SafeCodePublishError("project_required", "Code changes require a registered project");
    }
    if (action.kind !== "modify_code" || work.requiresHuman) {
      throw new SafeCodePublishError("invalid_change", "Code publication request rejected");
    }
    if (work.changes.length === 0 || work.changes.length > MAX_CHANGED_FILES) {
      throw new SafeCodePublishError("invalid_change", "Code change count rejected");
    }

    const project = await this.projects.get(task.projectId);
    if (!project) throw new SafeCodePublishError("project_not_found", "Project not found");
    if (project.status !== "active") {
      throw new SafeCodePublishError("project_inactive", "Project is not active");
    }

    const parsedChanges = work.changes.map((change) => {
      const parsed = SafeChangeSchema.safeParse(change);
      if (!parsed.success) {
        throw new SafeCodePublishError("invalid_change", "Unsafe code change rejected");
      }
      return parsed.data;
    });

    const paths = parsedChanges.map((change) => change.path);
    if (new Set(paths).size !== paths.length) {
      throw new SafeCodePublishError("duplicate_path", "Duplicate code-change paths rejected");
    }

    const totalChars = parsedChanges.reduce((sum, change) => sum + change.content.length, 0);
    if (totalChars > MAX_TOTAL_CHARS) {
      throw new SafeCodePublishError("change_too_large", "Code change payload exceeds limit");
    }

    const gateway = this.gatewayFactory(project.repository);
    const tree: GitHubTree = await gateway.listTree("main");
    if (tree.truncated) {
      throw new SafeCodePublishError("stale_source", "Repository tree is incomplete");
    }
    const existing = new Map(
      tree.entries
        .filter((entry) => entry.type === "blob")
        .map((entry) => [entry.path, entry.sha]),
    );

    for (const change of parsedChanges) {
      const currentSha = existing.get(change.path);
      if (change.operation === "update") {
        if (!change.sourceSha || currentSha !== change.sourceSha) {
          throw new SafeCodePublishError("stale_source", "Source changed before publication");
        }
      } else if (currentSha) {
        throw new SafeCodePublishError("create_conflict", "Create target already exists");
      }
    }

    const branch = await gateway.createFactoryBranch(task.id);
    for (const change of parsedChanges) {
      await gateway.writeFile({
        branch,
        path: change.path,
        content: change.content,
        message: "Factory code change: " + task.title.slice(0, 72),
        ...(change.operation === "update" ? { sha: change.sourceSha } : {}),
      });
    }

    const pullRequest = await gateway.openDraftPullRequest({
      branch,
      title: "Factory: " + task.title.slice(0, 110),
      body: [
        "AI-generated code change awaiting human review.",
        "",
        "Task: " + task.id,
        "Action: " + action.summary,
        "Files:",
        ...paths.map((path) => "- " + path),
        "",
        "Safety: draft PR only; protected paths rejected; production unchanged.",
      ].join("\n"),
    });

    return {
      projectId: project.id,
      repository: project.repository,
      branch,
      pullRequest,
      files: paths,
    };
  }
}
