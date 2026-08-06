import { describe, expect, it } from "vitest";
import { MissionControl } from "../src/mission-control/mission-control.js";
import { MemoryTaskStore } from "../src/store/task-store.js";

describe("MissionControl", () => {
  it("triages a feature into product architecture", async () => {
    const control = new MissionControl(new MemoryTaskStore());
    const task = await control.intake({
      title: "Add attendance export",
      description: "Build CSV attendance export for school admins",
      requestedBy: "Abu",
    });

    expect(task.status).toBe("triaged");
    expect(task.category).toBe("feature");
    expect(task.assignedAgent).toBe("product_architect");
    expect(task.risk).toBe("medium");
  });

  it("stops a production deployment for approval", async () => {
    const control = new MissionControl(new MemoryTaskStore());
    const task = await control.intake({
      title: "Release dashboard",
      description: "Deploy dashboard to production",
      requestedBy: "Abu",
      category: "deployment",
    });

    const planned = await control.addPlan(task.id, [
      { id: "test", kind: "run_tests", summary: "Run release tests", target: "repo", reversible: true },
      { id: "deploy", kind: "deploy_production", summary: "Deploy approved build", target: "production", reversible: true },
    ]);

    expect(planned.status).toBe("awaiting_approval");
    const approved = await control.approve(task.id);
    expect(approved.status).toBe("executing");
  });

  it("never lets a plan expose raw secrets", async () => {
    const control = new MissionControl(new MemoryTaskStore());
    const task = await control.intake({
      title: "Debug credentials",
      description: "Investigate an integration problem",
      requestedBy: "Abu",
      category: "security",
    });

    const planned = await control.addPlan(task.id, [
      { id: "secret", kind: "access_raw_secret", summary: "Read raw credential", target: "production secret", reversible: false },
    ]);

    expect(planned.status).toBe("human_required");
  });
});
