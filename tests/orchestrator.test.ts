import { describe, expect, it, vi } from "vitest";
import { MissionControl } from "../src/mission-control/mission-control.js";
import {
  MissionOrchestrator,
  type MissionPlanner,
} from "../src/mission-control/orchestrator.js";
import { MemoryTaskStore } from "../src/store/task-store.js";

async function triagedTask() {
  const store = new MemoryTaskStore();
  const control = new MissionControl(store);
  const task = await control.intake({
    title: "Build parent dashboard",
    description: "Create a parent dashboard feature",
    requestedBy: "Abu",
    category: "feature",
  });
  return { store, control, task };
}

describe("MissionOrchestrator", () => {
  it("turns an AI plan into an auditable ready mission", async () => {
    const { store, task } = await triagedTask();
    const planner = vi.fn<MissionPlanner>(async () => ({
      summary: "Implement and verify the dashboard",
      category: "feature",
      actions: [
        {
          kind: "modify_code",
          summary: "Implement dashboard UI",
          target: "web dashboard",
          reversible: true,
        },
        {
          kind: "run_tests",
          summary: "Run dashboard tests",
          target: "test suite",
          reversible: true,
        },
      ],
    }));

    const mission = await new MissionOrchestrator(store, planner).prepare(task.id);

    expect(mission.gate).toBe("ready");
    expect(mission.task.status).toBe("planned");
    expect(mission.task.plan.map((action) => action.id)).toEqual(["step-1", "step-2"]);
    expect(mission.task.audit.some((event) => event.event === "plan_added")).toBe(true);
    expect(planner).toHaveBeenCalledOnce();
  });

  it("pauses production work for Abu approval", async () => {
    const { store, task } = await triagedTask();
    const planner: MissionPlanner = async () => ({
      summary: "Release the verified change",
      category: "deployment",
      actions: [
        {
          kind: "deploy_production",
          summary: "Deploy the verified release",
          target: "production",
          reversible: true,
        },
      ],
    });

    const mission = await new MissionOrchestrator(store, planner).prepare(task.id);

    expect(mission.gate).toBe("approval_required");
    expect(mission.task.status).toBe("awaiting_approval");
    expect(mission.task.risk).toBe("high");
  });

  it("blocks plans that request raw secrets", async () => {
    const { store, task } = await triagedTask();
    const planner: MissionPlanner = async () => ({
      summary: "Inspect protected integration",
      category: "security",
      actions: [
        {
          kind: "access_raw_secret",
          summary: "Read a raw production secret",
          target: "production credential",
          reversible: false,
        },
      ],
    });

    const mission = await new MissionOrchestrator(store, planner).prepare(task.id);

    expect(mission.gate).toBe("human_required");
    expect(mission.task.status).toBe("human_required");
  });

  it("does not re-plan a task that already left triage", async () => {
    const { store, control, task } = await triagedTask();
    await control.addPlan(task.id, [
      {
        id: "existing",
        kind: "run_tests",
        summary: "Run existing tests",
        target: "repo",
        reversible: true,
      },
    ]);
    const planner = vi.fn<MissionPlanner>(async () => {
      throw new Error("planner must not run");
    });

    const orchestrator = new MissionOrchestrator(store, planner);
    await expect(orchestrator.prepare(task.id)).rejects.toMatchObject({
      code: "task_not_ready",
    });
    expect(planner).not.toHaveBeenCalled();
  });
});
