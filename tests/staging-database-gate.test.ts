import { describe, expect, it } from "vitest";
import type { PlannedAction, TaskRecord } from "../src/contracts/task.js";
import {
  StagingDatabaseGate,
  validateStagingSql,
} from "../src/database/staging-database-gate.js";
import { MemoryProjectStore } from "../src/store/project-store.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("staging database gate", () => {
  it("allows additive schema SQL", () => {
    const result = validateStagingSql(
      "CREATE TABLE attendance (id uuid primary key); ALTER TABLE attendance ADD COLUMN note text;",
    );
    expect(result).toEqual({ safe: true, statements: 2 });
  });

  it("blocks destructive and data-changing SQL", () => {
    expect(validateStagingSql("DROP TABLE attendance;").safe).toBe(false);
    expect(validateStagingSql("DELETE FROM attendance;").safe).toBe(false);
    expect(validateStagingSql("ALTER TABLE attendance DROP COLUMN note;").safe).toBe(false);
  });

  it("refuses staging credentials that resolve to production", async () => {
    const projects = new MemoryProjectStore();
    await projects.upsert({
      id: PROJECT_ID,
      name: "School SaaS",
      repository: "abu/school-saas",
      status: "active",
      config: {
        database: {
          stagingDatabaseEnv: "SCHOOL_STAGING_DATABASE_URL",
          productionDatabaseEnv: "SCHOOL_PRODUCTION_DATABASE_URL",
        },
      },
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    });

    const gate = new StagingDatabaseGate(projects, {
      SCHOOL_STAGING_DATABASE_URL: "postgresql://user:stage@db.example.com:5432/app",
      SCHOOL_PRODUCTION_DATABASE_URL: "postgresql://user:prod@db.example.com:5432/app",
    });
    const task = {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Add attendance table",
      description: "Create attendance schema",
      requestedBy: "Abu",
      projectId: PROJECT_ID,
      category: "database",
      assignedAgent: "engineer",
      risk: "medium",
      status: "executing",
      plan: [],
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
      audit: [],
    } satisfies TaskRecord;
    const action = {
      id: "db",
      kind: "migrate_staging_db",
      summary: "Create attendance schema",
      target: "staging database",
      reversible: true,
    } satisfies PlannedAction;

    await expect(gate.apply(task, action, {
      summary: "Add attendance table",
      sql: "CREATE TABLE attendance (id uuid primary key);",
      requiresHuman: false,
    })).rejects.toMatchObject({ code: "environment_collision" });
  });
});
