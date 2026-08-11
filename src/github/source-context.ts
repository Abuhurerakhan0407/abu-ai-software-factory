import type {
  PlannedAction,
  TaskRecord,
} from "../contracts/task.js";
import type { RepositoryContextFile } from "./repository-context.js";
import {
  SafeRepositoryNavigator,
  type RepositoryTreeResult,
} from "./safe-repository-navigator.js";
import {
  SafeRepositoryReader,
  type RepositoryReadResult,
} from "./safe-repository-reader.js";

const MAX_SOURCE_FILES = 5;
const MAX_SOURCE_CONTEXT_CHARS = 48_000;
const MAX_CHARS_PER_FILE = 12_000;
const MAX_SOURCE_FILE_BYTES = 256 * 1024;

const BOOTSTRAP_PATHS = ["README.md", "package.json"] as const;
const SOURCE_PREFIXES = [
  "src/", "app/", "api/", "lib/", "server/", "client/", "tests/",
] as const;
const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".vercel",
  "coverage",
  "vendor",
]);

const TEXT_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".php", ".rb",
  ".sql", ".graphql", ".gql", ".json", ".md", ".yaml", ".yml",
] as const;

const STOP_WORDS = new Set([
  "about", "accepts", "after", "again", "agent", "analyze", "build",
  "change", "code", "create", "file", "files", "focused", "from",
  "into", "js", "json", "jsx", "make", "modify", "mjs", "one",
  "only", "project", "repository", "review", "task", "test", "tests",
  "that", "this", "ts", "tsx", "valid", "verify", "verifying", "with",
]);

type RepositoryReader = Pick<SafeRepositoryReader, "read">;
type RepositoryNavigator = Pick<SafeRepositoryNavigator, "list">;

export class SourceRepositoryContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceRepositoryContextError";
  }
}

function splitTaskTerms(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
}

function taskTerms(task: TaskRecord, action: PlannedAction): string[] {
  const values = [
    task.title,
    task.description,
    action.summary,
    action.target,
  ];

  return [...new Set(
    values.flatMap((value) => splitTaskTerms(value)),
  )].slice(0, 24);
}

function isCandidateSourcePath(path: string): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return false;
  return TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function scorePath(path: string, terms: readonly string[]): number {
  const lower = path.toLowerCase();
  const basename = lower.split("/").at(-1) ?? lower;
  let score = SOURCE_PREFIXES.some((prefix) => lower.startsWith(prefix)) ? 2 : 0;

  for (const term of terms) {
    if (basename.includes(term)) score += 5;
    else if (lower.includes(term)) score += 3;
  }

  return score;
}

function sourceCandidates(
  tree: RepositoryTreeResult,
  task: TaskRecord,
  action: PlannedAction,
): string[] {
  const terms = taskTerms(task, action);

  return tree.entries
    .filter((entry) =>
      entry.type === "blob"
      && (entry.size === undefined || entry.size <= MAX_SOURCE_FILE_BYTES)
      && isCandidateSourcePath(entry.path)
      && !BOOTSTRAP_PATHS.includes(entry.path as (typeof BOOTSTRAP_PATHS)[number]))
    .map((entry) => ({
      path: entry.path,
      score: scorePath(entry.path, terms),
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((entry) => entry.path);
}

export function redactRepositorySecrets(content: string): string {
  return content
    .replace(
      /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]")
    .replace(
      /(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+(@)/gi,
      "$1[REDACTED_PASSWORD]$2",
    )
    .replace(
      /((?:password|secret|token|api[_-]?key|database_url)\s*[:=]\s*["'])([^"'\n]{8,})(["'])/gi,
      "$1[REDACTED_SECRET]$3",
    );
}

function toContextFile(
  file: RepositoryReadResult,
  remaining: number,
): RepositoryContextFile {
  const redacted = redactRepositorySecrets(file.content);
  const content = redacted.slice(0, Math.min(MAX_CHARS_PER_FILE, remaining));
  return {
    repository: file.repository,
    path: file.path,
    ref: file.ref,
    sha: file.sha,
    content,
  };
}

export class SourceAwareRepositoryContext {
  constructor(
    private readonly reader: RepositoryReader,
    private readonly navigator: RepositoryNavigator,
  ) {}

  async load(
    task: TaskRecord,
    action: PlannedAction,
  ): Promise<readonly RepositoryContextFile[]> {
    if (
      !task.projectId
      || (
        action.kind !== "analyze"
        && action.kind !== "modify_code"
        && action.kind !== "migrate_staging_db"
      )
    ) return [];

    const tree = await this.navigator.list({
      projectId: task.projectId,
      ref: "main",
    });
    const ranked = sourceCandidates(tree, task, action);
    const paths = [
      ...ranked.slice(0, 3),
      ...BOOTSTRAP_PATHS,
    ].slice(0, MAX_SOURCE_FILES);

    const files: RepositoryContextFile[] = [];
    let remaining = MAX_SOURCE_CONTEXT_CHARS;

    for (const path of paths) {
      if (files.length >= MAX_SOURCE_FILES || remaining <= 0) break;

      try {
        const file = await this.reader.read({
          projectId: task.projectId,
          path,
          ref: "main",
        });
        const contextFile = toContextFile(file, remaining);
        if (!contextFile.content) continue;
        files.push(contextFile);
        remaining -= contextFile.content.length;
      } catch {
        // Ranked candidates can disappear between tree and content reads.
      }
    }

    if (files.length === 0) {
      throw new SourceRepositoryContextError(
        "No safe source context could be loaded for this project",
      );
    }

    return files;
  }
}
