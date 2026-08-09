import { describe, expect, it } from "vitest";
import {
  FactoryAutopilot,
  isStaleAutonomousExecution,
} from "../src/autopilot/factory-autopilot.js";
import type { PlannedAction } from "../src/contracts/task.js";
import {
  MissionExecutor,
  type WorkerFn,
} from "../src/mission-control/executor.js";
import { MissionControl } from "../src/mission-control/mission-control.js";
import { MemoryAgentRunStore } from "../src/store/agent-run-store.js";
import { MemoryTaskStore } from "../src/store/task-store.js";

const headSha = "abcdef1234567890abcdef1234567890abcdef12";

describe("FactoryAutopilot", () => {
  it("submits a mission without running planner or executor work", async () => {
    const tasks = new MemoryTaskStore();
    let plannerCalls = 0;
    const autopilot = new FactoryAutopilot(
      tasks,
      async () => {
        plannerCalls += 1;
        throw new Error("planner must not run during submission");
      },
      async () => {
        throw new Error("executor must not run during submission");
      },
      async () => {
        throw new Error("monitor must not run during submission");
      },
    );

    const task = await autopilot.submit({
      request: "Run existing automated tests only",
    });

    expect(task.status).toBe("triaged");
    expect(plannerCalls).toBe(0);
    expect(await tasks.get(task.id)).toEqual(task);
  });

  it("runs a low-risk request from intake through completion", async () => {
    const tasks = new MemoryTaskStore();
    const runs = new MemoryAgentRunStore();
    const worker: WorkerFn = async () => ({
      summary: "Dashboard behavior analyzed",
      evidence: ["Repository evidence reviewed"],
      recommendations: ["Keep current behavior"],
      requiresHuman: false,
    });
    const executor = new MissionExecutor(tasks, runs, worker, "test-model");
    const autopilot = new FactoryAutopilot(
      tasks,
      async () => ({
        summary: "Analyze safely",
        category: "docs",
        actions: [{
          kind: "analyze",
          summary: "Analyze dashboard behavior",
          target: "dashboard",
          reversible: true,
        }],
      }),
      (taskId) => executor.execute(taskId),
      async () => {
        throw new Error("monitor must not run");
      },
    );

    const result = await autopilot.run({
      request: "Analyze dashboard behavior and recommend safe improvements",
    });

    expect(result.task.status).toBe("completed");
    expect(result.steps).toBe(2);
    expect(result.nextAction).toBe("done");
    expect(result.evidence).toEqual([{
      actionId: "1-analyze",
      summary: "Dashboard behavior analyzed",
      evidence: ["Repository evidence reviewed"],
      recommendations: ["Keep current behavior"],
      requiresHuman: false,
      recordedAt: result.task.updatedAt,
    }]);
    expect(runs.runs.size).toBe(1);
    expect(result.task.audit.some((event) => event.event === "plan_added")).toBe(true);
  });

  it("redacts secrets from execution evidence", async () => {
    const tasks = new MemoryTaskStore();
    const runs = new MemoryAgentRunStore();
    const worker: WorkerFn = async () => ({
      summary: "Bearer private-session-token",
      evidence: [
        "postgresql://user:password@example.com/factory",
        "FACTORY_API_TOKEN=super-secret-value",
        "gho_1234567890abcdef",
      ],
      recommendations: ["Keep DATABASE_URL=postgresql://user:password@example.com/factory private"],
      requiresHuman: false,
    });
    const executor = new MissionExecutor(tasks, runs, worker, "test-model");
    const autopilot = new FactoryAutopilot(
      tasks,
      async () => ({
        summary: "Analyze safely",
        category: "security",
        actions: [{
          kind: "analyze",
          summary: "Analyze repository evidence",
          target: "repository",
          reversible: true,
        }],
      }),
      (taskId) => executor.execute(taskId),
      async () => {
        throw new Error("monitor must not run");
      },
    );

    const result = await autopilot.run({
      request: "Analyze repository evidence safely",
    });

    const serialized = JSON.stringify(result.evidence);
    expect(result.task.status).toBe("completed");
    expect(result.evidence[0]?.summary).toBe("Bearer [redacted]");
    expect(serialized).not.toContain("private-session-token");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("1234567890abcdef");
    expect(serialized).toContain("[redacted");
  });

  it("records planner failure without crashing the API workflow", async () => {
    const tasks = new MemoryTaskStore();
    const autopilot = new FactoryAutopilot(
      tasks,
      async () => {
        throw new Error("provider returned malformed structured output");
      },
      async () => {
        throw new Error("executor must not run");
      },
      async () => {
        throw new Error("monitor must not run");
      },
    );

    const result = await autopilot.run({
      request: "Run existing automated tests only",
    });

    expect(result.task.status).toBe("failed");
    expect(result.nextAction).toBe("human_review");
    expect(result.task.audit.at(-1)?.detail).toContain(
      "AI planning failed; no execution attempted",
    );
  });

  it("defers planner quota exhaustion for human review", async () => {
    const tasks = new MemoryTaskStore();
    const autopilot = new FactoryAutopilot(
      tasks,
      async () => {
        throw Object.assign(
          new Error("429 Rate limit exceeded: free-models-per-day"),
          { status: 429, code: 429 },
        );
      },
      async () => {
        throw new Error("executor must not run");
      },
      async () => {
        throw new Error("monitor must not run");
      },
    );

    const result = await autopilot.run({
      request: "Run existing automated tests only",
    });

    expect(result.task.status).toBe("human_required");
    expect(result.nextAction).toBe("human_review");
    expect(result.task.audit.at(-1)?.detail).toContain(
      "AI planning quota exhausted",
    );
  });

  it("fails closed when interrupted execution becomes stale", async () => {
    const tasks = new MemoryTaskStore();
    const control = new MissionControl(tasks);
    const received = await control.intake({
      title: "Modify one test",
      description: "Modify one test safely",
      requestedBy: "Abu",
      category: "feature",
    });
    await control.addPlan(received.id, [{
      id: "1-modify_code",
      kind: "modify_code",
      summary: "Modify one test",
      target: "tests/example.test.ts",
      reversible: true,
    }]);
    const executing = await control.transition(
      received.id,
      "executing",
      "mission_control",
      "Autonomous execution started",
    );
    const stale = {
      ...executing,
      updatedAt: new Date(Date.now() - 7 * 60_000).toISOString(),
    };
    expect(isStaleAutonomousExecution(stale)).toBe(true);
    await tasks.upsert(stale);

    const autopilot = new FactoryAutopilot(
      tasks,
      async () => {
        throw new Error("planner must not run");
      },
      async () => {
        throw new Error("executor must not resume stale work");
      },
      async () => {
        throw new Error("monitor must not run");
      },
    );

    const result = await autopilot.run({ taskId: received.id });

    expect(result.task.status).toBe("failed");
    expect(result.nextAction).toBe("human_review");
    expect(result.task.audit.at(-1)?.detail).toContain(
      "Stale autonomous execution exceeded runtime limit",
    );
  });

  it("stops production work at human approval", async () => {
    const tasks = new MemoryTaskStore();
    let executeCalls = 0;
    const autopilot = new FactoryAutopilot(
      tasks,
      async () => ({
        summary: "Deploy reviewed pull request",
        category: "deployment",
        actions: [{
          kind: "deploy_production",
          summary: "Deploy reviewed pull request",
          target: "pull_request:42",
          reversible: true,
        }],
      }),
      async () => {
        executeCalls += 1;
        throw new Error("executor must not run before approval");
      },
      async () => {
        throw new Error("monitor must not run before deployment");
      },
    );

    const result = await autopilot.run({
      request: "Deploy pull request 42 to production",
    });

    expect(result.task.status).toBe("awaiting_approval");
    expect(result.nextAction).toBe("human_approval");
    expect(executeCalls).toBe(0);
  });

  it("keeps blocked secret access human-gated", async () => {
    const tasks = new MemoryTaskStore();
    const autopilot = new FactoryAutopilot(
      tasks,
      async () => ({
        summary: "Unsafe credential request",
        category: "security",
        actions: [{
          kind: "access_raw_secret",
          summary: "Read a raw production secret",
          target: "production",
          reversible: false,
        }],
      }),
      async () => {
        throw new Error("executor must not run");
      },
      async () => {
        throw new Error("monitor must not run");
      },
    );

    const result = await autopilot.run({
      request: "Read a raw production credential",
    });

    expect(result.task.status).toBe("human_required");
    expect(result.nextAction).toBe("human_review");
  });

  it("takes only one production health sample per invocation", async () => {
    const tasks = new MemoryTaskStore();
    const control = new MissionControl(tasks);
    const received = await control.intake({
      title: "Deploy verified release",
      description: "Deploy verified release",
      requestedBy: "Abu",
      category: "deployment",
    });
    const action: PlannedAction = {
      id: "deploy",
      kind: "deploy_production",
      summary: "Deploy reviewed pull request",
      target: "pull_request:42",
      reversible: true,
    };
    await control.addPlan(received.id, [action]);
    await control.approveProduction(
      received.id,
      { pullRequest: 42, headSha },
      "Abu",
    );
    await control.transition(received.id, "verifying", "qa_security", "Verified");
    await control.transition(received.id, "staging", "qa_security", "Staged");
    await control.transition(received.id, "deploying", "sre", "Deploying");

    let monitorCalls = 0;
    const autopilot = new FactoryAutopilot(
      tasks,
      async () => {
        throw new Error("planner must not run");
      },
      async () => {
        throw new Error("executor must not run");
      },
      async (taskId) => {
        monitorCalls += 1;
        const task = await tasks.get(taskId);
        if (!task) throw new Error("task missing");
        return { task };
      },
    );

    const result = await autopilot.run({ taskId: received.id });

    expect(monitorCalls).toBe(1);
    expect(result.steps).toBe(1);
    expect(result.nextAction).toBe("call_again");
  });
});
