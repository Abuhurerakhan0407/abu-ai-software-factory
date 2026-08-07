import { describe, expect, it } from "vitest";
import { ProjectInputSchema } from "../src/contracts/project.js";
import { MissionControl } from "../src/mission-control/mission-control.js";
import { MemoryProjectStore } from "../src/store/project-store.js";
import { MemoryTaskStore } from "../src/store/task-store.js";

describe("project registry", () => {
  it("accepts owner/name repositories and rejects URLs", () => {
    expect(ProjectInputSchema.parse({
      name: "School SaaS",
      repository: "abu/school-saas",
    }).repository).toBe("abu/school-saas");

    expect(() => ProjectInputSchema.parse({
      name: "School SaaS",
      repository: "https://github.com/abu/school-saas",
    })).toThrow();
  });

  it("stores registered projects", async () => {
    const store = new MemoryProjectStore();
    const now = new Date().toISOString();
    await store.upsert({
      id: "11111111-1111-4111-8111-111111111111",
      name: "School SaaS",
      repository: "abu/school-saas",
      status: "active",
      config: {},
      createdAt: now,
      updatedAt: now,
    });

    expect((await store.list())[0]?.repository).toBe("abu/school-saas");
  });

  it("keeps the target project on task intake", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const control = new MissionControl(new MemoryTaskStore());
    const task = await control.intake({
      title: "Add student attendance",
      description: "Create attendance UI and API",
      requestedBy: "Abu",
      projectId,
    });

    expect(task.projectId).toBe(projectId);
  });
});
