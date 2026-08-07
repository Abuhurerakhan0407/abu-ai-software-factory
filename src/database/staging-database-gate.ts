import { createHash } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";
import type { StagingMigrationWork } from "../agents/staging-migration-worker.js";
import type { PlannedAction, TaskRecord } from "../contracts/task.js";
import type { ProjectStore } from "../store/project-store.js";

const DatabaseConfigSchema = z.object({
  stagingDatabaseEnv: z.string().regex(/^[A-Z][A-Z0-9_]{2,80}$/),
  productionDatabaseEnv: z.string().regex(/^[A-Z][A-Z0-9_]{2,80}$/),
}).refine(
  (config) => config.stagingDatabaseEnv !== config.productionDatabaseEnv,
  "Staging and production database env keys must differ",
);

const MAX_SQL_CHARS = 12_000;

const FORBIDDEN_SQL = /\b(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT|MERGE|GRANT|REVOKE|COPY|CALL|DO|EXECUTE|PREPARE|CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|TRIGGER|EXTENSION|POLICY|ROLE|USER)|ALTER\s+(?:ROLE|SYSTEM|DATABASE)|SET\s+ROLE|RESET\s+ROLE|SECURITY\s+DEFINER|PG_READ_FILE|PG_WRITE_FILE|DBLINK)\b/i;
const FORBIDDEN_ALTER = /\b(?:DROP|RENAME|DISABLE|ENABLE)\b/i;
const ALLOWED_STATEMENT = /^(?:CREATE\s+(?:UNIQUE\s+)?INDEX\b|CREATE\s+TABLE\b|CREATE\s+TYPE\b|CREATE\s+SCHEMA\b|ALTER\s+TABLE\b|ALTER\s+TYPE\b)/i;

export type StagingMigrationResult = {
  applied: true;
  environment: "staging";
  fingerprint: string;
  statements: number;
};

export class StagingDatabaseGateError extends Error {
  constructor(
    readonly code:
      | "project_required"
      | "project_not_found"
      | "project_inactive"
      | "database_not_configured"
      | "environment_collision"
      | "unsafe_sql"
      | "migration_failed",
    message: string,
  ) {
    super(message);
    this.name = "StagingDatabaseGateError";
  }
}

export function validateStagingSql(sqlText: string): {
  safe: boolean;
  statements: number;
} {
  const trimmed = sqlText.trim();
  if (!trimmed || trimmed.length > MAX_SQL_CHARS) {
    return { safe: false, statements: 0 };
  }
  if (trimmed.includes("--") || trimmed.includes("/*") || FORBIDDEN_SQL.test(trimmed)) {
    return { safe: false, statements: 0 };
  }

  const statements = trimmed
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  if (statements.length === 0 || statements.length > 20) {
    return { safe: false, statements: statements.length };
  }

  for (const statement of statements) {
    if (!ALLOWED_STATEMENT.test(statement)) {
      return { safe: false, statements: statements.length };
    }
    if (/^ALTER\s+TABLE\b/i.test(statement) && FORBIDDEN_ALTER.test(statement)) {
      return { safe: false, statements: statements.length };
    }
    if (/^ALTER\s+TYPE\b/i.test(statement) && !/\bADD\s+VALUE\b/i.test(statement)) {
      return { safe: false, statements: statements.length };
    }
  }

  return { safe: true, statements: statements.length };
}

function databaseIdentity(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new StagingDatabaseGateError(
      "database_not_configured",
      "Database URL must use PostgreSQL",
    );
  }
  return [
    url.hostname.toLowerCase(),
    url.port || "5432",
    decodeURIComponent(url.username).toLowerCase(),
    url.pathname.toLowerCase(),
  ].join("|");
}

export class StagingDatabaseGate {
  constructor(
    private readonly projects: ProjectStore,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async apply(
    task: TaskRecord,
    action: PlannedAction,
    work: StagingMigrationWork,
  ): Promise<StagingMigrationResult> {
    if (!task.projectId || action.kind !== "migrate_staging_db") {
      throw new StagingDatabaseGateError(
        "project_required",
        "Staging migration requires a registered project",
      );
    }
    if (work.requiresHuman) {
      throw new StagingDatabaseGateError(
        "unsafe_sql",
        "Migration worker requested human review",
      );
    }

    const project = await this.projects.get(task.projectId);
    if (!project) {
      throw new StagingDatabaseGateError("project_not_found", "Project not found");
    }
    if (project.status !== "active") {
      throw new StagingDatabaseGateError("project_inactive", "Project is not active");
    }

    const config = DatabaseConfigSchema.safeParse(project.config.database);
    if (!config.success) {
      throw new StagingDatabaseGateError(
        "database_not_configured",
        "Project staging and production database identities are required",
      );
    }

    const stagingUrl = this.environment[config.data.stagingDatabaseEnv];
    const productionUrl = this.environment[config.data.productionDatabaseEnv];
    if (!stagingUrl || !productionUrl) {
      throw new StagingDatabaseGateError(
        "database_not_configured",
        "Project database environment is incomplete",
      );
    }

    let stagingIdentity: string;
    let productionIdentity: string;
    try {
      stagingIdentity = databaseIdentity(stagingUrl);
      productionIdentity = databaseIdentity(productionUrl);
    } catch (error) {
      if (error instanceof StagingDatabaseGateError) throw error;
      throw new StagingDatabaseGateError(
        "database_not_configured",
        "Project database URL is invalid",
      );
    }

    if (stagingIdentity === productionIdentity || stagingUrl === productionUrl) {
      throw new StagingDatabaseGateError(
        "environment_collision",
        "Staging database resolves to production identity",
      );
    }

    const policy = validateStagingSql(work.sql);
    if (!policy.safe) {
      throw new StagingDatabaseGateError(
        "unsafe_sql",
        "Migration SQL is outside additive staging policy",
      );
    }

    const sql = postgres(stagingUrl, {
      max: 1,
      prepare: false,
      ssl: "require",
      connect_timeout: 10,
      idle_timeout: 5,
      connection: { application_name: "abu-ai-factory-staging-gate" },
    });

    const rollbackMarker = new Error("staging_dry_run_rollback");
    try {
      try {
        await sql.begin(async (transaction) => {
          await transaction.unsafe(work.sql);
          throw rollbackMarker;
        });
      } catch (error) {
        if (error !== rollbackMarker) throw error;
      }

      await sql.begin(async (transaction) => {
        await transaction.unsafe(work.sql);
      });
    } catch {
      throw new StagingDatabaseGateError(
        "migration_failed",
        "Staging migration failed validation or application",
      );
    } finally {
      await sql.end({ timeout: 5 });
    }

    return {
      applied: true,
      environment: "staging",
      fingerprint: createHash("sha256").update(work.sql).digest("hex").slice(0, 16),
      statements: policy.statements,
    };
  }
}
