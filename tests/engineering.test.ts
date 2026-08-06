import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EngineeringJob } from "../src/engineering/contracts.js";
import { buildCodexThreadOptions, buildEngineeringPrompt } from "../src/engineering/codex-worker.js";
import { assertExecutableAllowed } from "../src/engineering/sandbox.js";

function job(): EngineeringJob {
  return {
    id: randomUUID(),
    taskId: randomUUID(),
    workspacePath: "/safe/workspace",
    instruction: "Add attendance export",
    acceptanceCriteria: ["School admin can download a CSV"],
    verificationCommands: [["npm", "test"]],
  };
}

describe("engineering worker boundaries", () => {
  it("starts Codex with workspace-only writes and no network", () => {
    const options = buildCodexThreadOptions(job());
    expect(options.sandboxMode).toBe("workspace-write");
    expect(options.networkAccessEnabled).toBe(false);
    expect(options.webSearchMode).toBe("disabled");
    expect(options.skipGitRepoCheck).toBe(false);
  });

  it("puts safety rules into every engineering job", () => {
    const prompt = buildEngineeringPrompt(job());
    expect(prompt).toContain("Never access production systems");
    expect(prompt).toContain("Do not commit or push");
    expect(prompt).toContain("School admin can download a CSV");
  });

  it("allows normal verification commands", () => {
    expect(() => assertExecutableAllowed("npm")).not.toThrow();
    expect(() => assertExecutableAllowed("git")).not.toThrow();
  });

  it("rejects arbitrary executables at sandbox gateway", () => {
    expect(() => assertExecutableAllowed("curl")).toThrow(/not allowlisted/);
    expect(() => assertExecutableAllowed("bash")).toThrow(/not allowlisted/);
  });
});
