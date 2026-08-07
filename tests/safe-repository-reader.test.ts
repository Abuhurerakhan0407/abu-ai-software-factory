import { describe, expect, it, vi } from "vitest";
import type { ProjectRecord } from "../src/contracts/project.js";
import {
  RepositoryReadError,
  SafeRepositoryReader,
} from "../src/github/safe-repository-reader.js";
import { MemoryProjectStore } from "../src/store/project-store.js";

const project: ProjectRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Factory",
  repository: "Abuhurerakhan0407/abu-ai-software-factory",
  status: "active",
  config: {},
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
};

async function setup(status: ProjectRecord["status"] = "active") {
  const projects = new MemoryProjectStore();
  await projects.upsert({ ...project, status });
  const getFile = vi.fn(async () => ({
    sha: "abc123",
    content: "# Factory\n",
  }));
  const reader = new SafeRepositoryReader(projects, () => ({ getFile }));
  return { reader, getFile };
}

describe("SafeRepositoryReader", () => {
  it("reads only from the registered active project repository", async () => {
    const { reader, getFile } = await setup();

    const result = await reader.read({
      projectId: project.id,
      path: "README.md",
      ref: "main",
    });

    expect(result.repository).toBe(project.repository);
    expect(result.content).toBe("# Factory\n");
    expect(getFile).toHaveBeenCalledWith("README.md", "main");
  });

  it.each([
    ".env",
    ".env.production",
    ".env/notes.txt",
    ".ssh/config",
    ".aws/credentials",
    "config/private.key",
    "certs/service.pem",
    "../README.md",
    "/README.md",
  ])("blocks sensitive or unsafe path %s", async (path) => {
    const { reader, getFile } = await setup();

    await expect(reader.read({
      projectId: project.id,
      path,
      ref: "main",
    })).rejects.toMatchObject({
      code: "invalid_request",
    } satisfies Partial<RepositoryReadError>);
    expect(getFile).not.toHaveBeenCalled();
  });

  it("blocks reads for inactive projects", async () => {
    const { reader, getFile } = await setup("paused");

    await expect(reader.read({
      projectId: project.id,
      path: "README.md",
      ref: "main",
    })).rejects.toMatchObject({
      code: "project_inactive",
    } satisfies Partial<RepositoryReadError>);
    expect(getFile).not.toHaveBeenCalled();
  });

  it("rejects oversized files", async () => {
    const projects = new MemoryProjectStore();
    await projects.upsert(project);
    const getFile = vi.fn(async () => ({
      sha: "abc123",
      content: "x".repeat(256 * 1024 + 1),
    }));
    const reader = new SafeRepositoryReader(projects, () => ({ getFile }));

    await expect(reader.read({
      projectId: project.id,
      path: "large.txt",
      ref: "main",
    })).rejects.toMatchObject({
      code: "content_too_large",
    } satisfies Partial<RepositoryReadError>);
  });
});
