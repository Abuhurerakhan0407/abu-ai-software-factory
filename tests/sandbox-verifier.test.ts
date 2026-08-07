import { describe, expect, it, vi } from "vitest";
import { SandboxVerifier } from "../src/execution/sandbox-verifier.js";

function repository() {
  const files = new Map([
    ["package.json", JSON.stringify({
      scripts: {
        test: "vitest run",
        build: "tsc -p tsconfig.json",
      },
    })],
    ["src/index.ts", "export const value = 1;\n"],
  ]);

  return {
    gateway: {
      listTree: vi.fn(async () => ({
        entries: [
          { path: ".env", type: "blob" as const, sha: "secret", size: 20 },
          { path: "package.json", type: "blob" as const, sha: "package", size: 120 },
          { path: "src/index.ts", type: "blob" as const, sha: "source", size: 30 },
        ],
        truncated: false,
      })),
      getFile: vi.fn(async (path: string) => ({
        sha: path === "package.json" ? "package" : "source",
        content: files.get(path) ?? "",
      })),
    },
  };
}

function sandbox(exitCodes: number[]) {
  let check = 0;
  return {
    writeFiles: vi.fn(async () => undefined),
    run: vi.fn(async (command: string) => {
      if (command === "mkdir") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const exitCode = exitCodes[check++] ?? 0;
      return {
        exitCode,
        stdout: exitCode === 0 ? "ok" : "failed",
        stderr: "",
      };
    }),
    lockNetwork: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

describe("SandboxVerifier", () => {
  it("runs install and repository checks with secrets excluded", async () => {
    const repo = repository();
    const isolated = sandbox([0, 0, 0]);

    const result = await new SandboxVerifier(
      () => repo.gateway,
      async () => isolated,
    ).verify({
      repository: "abu/school-saas",
      ref: "factory/task",
    });

    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => check.label)).toEqual([
      "install",
      "test",
      "build",
    ]);
    expect(isolated.lockNetwork).toHaveBeenCalledOnce();
    expect(repo.gateway.getFile).not.toHaveBeenCalledWith(".env", expect.anything());
    expect(isolated.stop).toHaveBeenCalledOnce();
  });

  it("marks failed generated-code checks as repairable", async () => {
    const repo = repository();
    const isolated = sandbox([0, 1]);

    const result = await new SandboxVerifier(
      () => repo.gateway,
      async () => isolated,
    ).verify({
      repository: "abu/school-saas",
      ref: "factory/task",
    });

    expect(result.passed).toBe(false);
    expect(result.repairable).toBe(true);
    expect(result.summary).toContain("test failed");
    expect(isolated.stop).toHaveBeenCalledOnce();
  });

  it("fails closed when the repository tree is incomplete", async () => {
    const result = await new SandboxVerifier(
      () => ({
        listTree: vi.fn(async () => ({ entries: [], truncated: true })),
        getFile: vi.fn(),
      }),
      async () => sandbox([]),
    ).verify({
      repository: "abu/school-saas",
      ref: "factory/task",
    });

    expect(result.passed).toBe(false);
    expect(result.repairable).toBe(false);
  });
});
