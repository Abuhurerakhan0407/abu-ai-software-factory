import { describe, expect, it, vi } from "vitest";
import type { ProjectRecord } from "../src/contracts/project.js";
import {
  RepositoryTreeError,
  SafeRepositoryNavigator,
} from "../src/github/safe-repository-navigator.js";
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

async function projectStore(status: ProjectRecord["status"] = "active") {
  const projects = new MemoryProjectStore();
  await projects.upsert({ ...project, status });
  return projects;
}

describe("SafeRepositoryNavigator", () => {
  it("lists project files while hiding sensitive path names", async () => {
    const projects = await projectStore();
    const listTree = vi.fn(async () => ({
      truncated: false,
      entries: [
        { path: "README.md", type: "blob" as const, sha: "readme", size: 10 },
        { path: ".env.production", type: "blob" as const, sha: "env", size: 10 },
        { path: ".env/notes.txt", type: "blob" as const, sha: "nested-env", size: 10 },
        { path: ".ssh/config", type: "blob" as const, sha: "ssh", size: 10 },
        { path: ".aws/credentials", type: "blob" as const, sha: "aws", size: 10 },
        { path: "certs/app.key", type: "blob" as const, sha: "key", size: 10 },
        { path: "src/index.ts", type: "blob" as const, sha: "src", size: 20 },
      ],
    }));
    const navigator = new SafeRepositoryNavigator(
      projects,
      () => ({ listTree }),
    );

    const result = await navigator.list({
      projectId: project.id,
      ref: "main",
    });

    expect(result.repository).toBe(project.repository);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "README.md",
      "src/index.ts",
    ]);
  });

  it("blocks navigation for inactive projects", async () => {
    const projects = await projectStore("paused");
    const listTree = vi.fn();
    const navigator = new SafeRepositoryNavigator(
      projects,
      () => ({ listTree }),
    );

    await expect(navigator.list({
      projectId: project.id,
      ref: "main",
    })).rejects.toMatchObject({
      code: "project_inactive",
    } satisfies Partial<RepositoryTreeError>);
    expect(listTree).not.toHaveBeenCalled();
  });

  it("rejects truncated GitHub trees", async () => {
    const projects = await projectStore();
    const navigator = new SafeRepositoryNavigator(
      projects,
      () => ({
        listTree: async () => ({ entries: [], truncated: true }),
      }),
    );

    await expect(navigator.list({
      projectId: project.id,
      ref: "main",
    })).rejects.toMatchObject({
      code: "tree_truncated",
    } satisfies Partial<RepositoryTreeError>);
  });

  it("rejects repository maps above the navigation limit", async () => {
    const projects = await projectStore();
    const entries = Array.from({ length: 2_001 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      type: "blob" as const,
      sha: `sha-${index}`,
      size: 1,
    }));
    const navigator = new SafeRepositoryNavigator(
      projects,
      () => ({
        listTree: async () => ({ entries, truncated: false }),
      }),
    );

    await expect(navigator.list({
      projectId: project.id,
      ref: "main",
    })).rejects.toMatchObject({
      code: "tree_too_large",
    } satisfies Partial<RepositoryTreeError>);
  });
});
