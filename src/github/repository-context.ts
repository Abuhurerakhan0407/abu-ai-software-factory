import type {
  PlannedAction,
  TaskRecord,
} from "../contracts/task.js";
import {
  SafeRepositoryReader,
  type RepositoryReadResult,
} from "./safe-repository-reader.js";

const DEFAULT_CONTEXT_PATHS = ["README.md", "package.json"] as const;
const MAX_REPOSITORY_CONTEXT_CHARS = 24_000;

export type RepositoryContextFile = Pick<
  RepositoryReadResult,
  "repository" | "path" | "ref" | "sha" | "content"
>;

export type RepositoryContextLoader = (
  task: TaskRecord,
  action: PlannedAction,
) => Promise<readonly RepositoryContextFile[]>;

type RepositoryReader = Pick<SafeRepositoryReader, "read">;

export class RepositoryContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryContextError";
  }
}

export class SafeRepositoryContext {
  constructor(
    private readonly reader: RepositoryReader,
    private readonly contextPaths: readonly string[] = DEFAULT_CONTEXT_PATHS,
  ) {}

  async load(
    task: TaskRecord,
    action: PlannedAction,
  ): Promise<readonly RepositoryContextFile[]> {
    if (!task.projectId || action.kind !== "analyze") return [];

    const files: RepositoryContextFile[] = [];
    let remaining = MAX_REPOSITORY_CONTEXT_CHARS;

    for (const path of this.contextPaths) {
      if (remaining <= 0) break;

      try {
        const file = await this.reader.read({
          projectId: task.projectId,
          path,
          ref: "main",
        });
        const content = file.content.slice(0, remaining);
        remaining -= content.length;
        files.push({
          repository: file.repository,
          path: file.path,
          ref: file.ref,
          sha: file.sha,
          content,
        });
      } catch {
        // Repositories differ. Missing optional context files are expected.
      }
    }

    if (files.length === 0) {
      throw new RepositoryContextError(
        "No safe repository context could be loaded for this project",
      );
    }

    return files;
  }
}
