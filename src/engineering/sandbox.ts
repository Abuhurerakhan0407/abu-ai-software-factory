import { Sandbox } from "@vercel/sandbox";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxWorkspace {
  run(command: string, args?: string[]): Promise<CommandResult>;
  close(): Promise<void>;
}

export interface SandboxProvider {
  create(input: { repoUrl: string; revision?: string }): Promise<SandboxWorkspace>;
}

const ALLOWED_EXECUTABLES = new Set([
  "npm",
  "npx",
  "node",
  "git",
  "pnpm",
  "yarn",
  "bun",
]);

export function assertExecutableAllowed(command: string): void {
  if (!ALLOWED_EXECUTABLES.has(command)) {
    throw new Error(`Sandbox command not allowlisted: ${command}`);
  }
}

export class VercelSandboxProvider implements SandboxProvider {
  async create(input: { repoUrl: string; revision?: string }): Promise<SandboxWorkspace> {
    if (!input.repoUrl.startsWith("https://")) {
      throw new Error("Sandbox repository URL must use HTTPS");
    }

    const sandbox = await Sandbox.create({
      runtime: "node24",
      source: {
        type: "git",
        url: input.repoUrl,
        depth: 1,
        ...(input.revision ? { revision: input.revision } : {}),
      },
      timeout: 20 * 60 * 1000,
      networkPolicy: {
        allow: {
          "registry.npmjs.org": [],
        },
      },
      tags: { purpose: "engineering-worker" },
    });

    return {
      async run(command, args = []) {
        assertExecutableAllowed(command);
        const result = await sandbox.runCommand(command, args, { timeoutMs: 10 * 60 * 1000 });
        return {
          exitCode: result.exitCode,
          stdout: await result.stdout(),
          stderr: await result.stderr(),
        };
      },
      async close() {
        await sandbox.stop();
      },
    };
  }
}
