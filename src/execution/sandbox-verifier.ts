import { Sandbox } from "@vercel/sandbox";
import {
  getProductionGitHubGateway,
  type GitHubGateway,
  type GitHubTreeEntry,
} from "../github/github-gateway.js";
import { isSensitiveRepositoryPath } from "../github/repository-path-policy.js";

const MAX_SNAPSHOT_FILES = 240;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LOG_CHARS = 12_000;

const IGNORED_SEGMENTS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
]);

const SNAPSHOT_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".yaml", ".yml", ".css", ".scss", ".html",
  ".graphql", ".gql", ".sql", ".sh",
  ".py", ".go", ".rs", ".java", ".kt", ".php", ".rb",
] as const;

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

type SnapshotFile = {
  path: string;
  content: string;
};

export type SandboxCheckResult = {
  label: "install" | "typecheck" | "test" | "build";
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type SandboxVerification = {
  passed: boolean;
  repairable: boolean;
  checks: SandboxCheckResult[];
  summary: string;
};

type GatewayReader = Pick<GitHubGateway, "listTree" | "getFile">;
type GatewayFactory = (repository: string) => GatewayReader;

type SandboxCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

interface SandboxSession {
  writeFiles(files: Array<{ path: string; content: string }>): Promise<unknown>;
  run(command: string, args?: string[]): Promise<SandboxCommandResult>;
  lockNetwork(): Promise<void>;
  stop(): Promise<unknown>;
}

type SandboxFactory = () => Promise<SandboxSession>;

function isSnapshotPath(path: string): boolean {
  if (isSensitiveRepositoryPath(path)) return false;
  const segments = path.toLowerCase().split("/");
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return false;

  const basename = segments.at(-1) ?? "";
  return LOCKFILES.has(basename)
    || SNAPSHOT_EXTENSIONS.some((extension) => basename.endsWith(extension));
}

function eligibleEntries(entries: readonly GitHubTreeEntry[]): GitHubTreeEntry[] {
  return entries
    .filter((entry) =>
      entry.type === "blob"
      && isSnapshotPath(entry.path)
      && (entry.size === undefined || entry.size <= MAX_SNAPSHOT_FILE_BYTES))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function truncateLog(value: string): string {
  if (value.length <= MAX_LOG_CHARS) return value;
  return value.slice(0, MAX_LOG_CHARS) + "\n[truncated]";
}

function directories(files: readonly SnapshotFile[]): string[] {
  const dirs = new Set<string>(["repo"]);
  for (const file of files) {
    const parts = file.path.split("/");
    parts.pop();
    let current = "repo";
    for (const part of parts) {
      current += "/" + part;
      dirs.add(current);
    }
  }
  return [...dirs];
}

function parsePackageScripts(packageFile: SnapshotFile): Record<string, string> {
  const parsed = JSON.parse(packageFile.content) as { scripts?: unknown };
  if (!parsed.scripts || typeof parsed.scripts !== "object") return {};

  return Object.fromEntries(
    Object.entries(parsed.scripts)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function packageManagerInstall(files: readonly SnapshotFile[]): string {
  const paths = new Set(files.map((file) => file.path));
  if (paths.has("pnpm-lock.yaml")) return "corepack pnpm install --frozen-lockfile";
  if (paths.has("yarn.lock")) return "corepack yarn install --immutable";
  if (paths.has("package-lock.json")) return "npm ci";
  return "npm install";
}

function checkCommands(scripts: Record<string, string>): Array<{
  label: "typecheck" | "test" | "build";
  command: string;
}> {
  const checks: Array<{ label: "typecheck" | "test" | "build"; command: string }> = [];
  if (scripts.typecheck) checks.push({ label: "typecheck", command: "npm run typecheck" });
  if (scripts.test) checks.push({ label: "test", command: "npm test" });
  if (scripts.build) checks.push({ label: "build", command: "npm run build" });
  return checks;
}

async function createProductionSandbox(): Promise<SandboxSession> {
  const sandbox = await Sandbox.create({
    runtime: "node24",
    timeout: 180_000,
    persistent: false,
    networkPolicy: "allow-all",
  });

  return {
    writeFiles: (files) => sandbox.writeFiles(files),
    run: async (command, args = []) => {
      const result = await sandbox.runCommand(command, args);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    lockNetwork: async () => {
      await sandbox.update({ networkPolicy: "deny-all" });
    },
    stop: () => sandbox.stop(),
  };
}

export class SandboxVerifier {
  constructor(
    private readonly gatewayFactory: GatewayFactory = getProductionGitHubGateway,
    private readonly sandboxFactory: SandboxFactory = createProductionSandbox,
  ) {}

  async verify(input: {
    repository: string;
    ref: string;
  }): Promise<SandboxVerification> {
    const gateway = this.gatewayFactory(input.repository);
    const tree = await gateway.listTree(input.ref);
    if (tree.truncated) {
      return {
        passed: false,
        repairable: false,
        checks: [],
        summary: "Repository tree is incomplete; sandbox verification refused",
      };
    }

    const entries = eligibleEntries(tree.entries);
    const declaredBytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    if (entries.length > MAX_SNAPSHOT_FILES || declaredBytes > MAX_SNAPSHOT_BYTES) {
      return {
        passed: false,
        repairable: false,
        checks: [],
        summary: "Repository snapshot exceeds sandbox safety limits",
      };
    }

    const files: SnapshotFile[] = [];
    let actualBytes = 0;
    for (const entry of entries) {
      const file = await gateway.getFile(entry.path, input.ref);
      actualBytes += Buffer.byteLength(file.content, "utf8");
      if (actualBytes > MAX_SNAPSHOT_BYTES) {
        return {
          passed: false,
          repairable: false,
          checks: [],
          summary: "Repository snapshot exceeds sandbox safety limits",
        };
      }
      files.push({ path: entry.path, content: file.content });
    }

    const packageFile = files.find((file) => file.path === "package.json");
    if (!packageFile) {
      return {
        passed: false,
        repairable: false,
        checks: [],
        summary: "No supported Node.js package.json found for sandbox verification",
      };
    }

    let scripts: Record<string, string>;
    try {
      scripts = parsePackageScripts(packageFile);
    } catch {
      return {
        passed: false,
        repairable: false,
        checks: [],
        summary: "package.json is invalid; sandbox verification refused",
      };
    }

    const verificationCommands = checkCommands(scripts);
    if (verificationCommands.length === 0) {
      return {
        passed: false,
        repairable: false,
        checks: [],
        summary: "No typecheck, test, or build script is available",
      };
    }

    const sandbox = await this.sandboxFactory();
    const checks: SandboxCheckResult[] = [];

    try {
      await sandbox.run("mkdir", ["-p", ...directories(files)]);
      await sandbox.writeFiles(
        files.map((file) => ({
          path: "repo/" + file.path,
          content: file.content,
        })),
      );

      const installCommand = packageManagerInstall(files);
      const install = await sandbox.run("sh", ["-lc", "cd repo && " + installCommand]);
      const installResult: SandboxCheckResult = {
        label: "install",
        command: installCommand,
        exitCode: install.exitCode,
        stdout: truncateLog(install.stdout),
        stderr: truncateLog(install.stderr),
      };
      checks.push(installResult);

      if (install.exitCode !== 0) {
        return {
          passed: false,
          repairable: false,
          checks,
          summary: "Dependency installation failed in the isolated sandbox",
        };
      }

      await sandbox.lockNetwork();

      for (const check of verificationCommands) {
        const result = await sandbox.run("sh", [
          "-lc",
          "cd repo && CI=1 " + check.command,
        ]);
        const recorded: SandboxCheckResult = {
          label: check.label,
          command: check.command,
          exitCode: result.exitCode,
          stdout: truncateLog(result.stdout),
          stderr: truncateLog(result.stderr),
        };
        checks.push(recorded);

        if (result.exitCode !== 0) {
          return {
            passed: false,
            repairable: true,
            checks,
            summary: check.label + " failed in the isolated sandbox",
          };
        }
      }

      return {
        passed: true,
        repairable: false,
        checks,
        summary: "Isolated sandbox checks passed",
      };
    } finally {
      await sandbox.stop();
    }
  }
}
