import postgres from "postgres";
import { ProjectRecordSchema, type ProjectRecord } from "../contracts/project.js";
import type { ProjectStore } from "./project-store.js";

type ProjectRow = {
  id: string;
  name: string;
  repository: string;
  status: string;
  config: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function hydrate(row: ProjectRow): ProjectRecord {
  return ProjectRecordSchema.parse({
    id: row.id,
    name: row.name,
    repository: row.repository,
    status: row.status,
    config: row.config ?? {},
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export class PostgresProjectStore implements ProjectStore {
  private readonly sql: ReturnType<typeof postgres>;

  constructor(connectionString: string) {
    if (!connectionString) throw new Error("DATABASE_URL is required");
    this.sql = postgres(connectionString, {
      max: 2,
      prepare: false,
      ssl: "require",
      connection: { application_name: "abu-ai-software-factory-projects" },
    });
  }

  async get(id: string): Promise<ProjectRecord | undefined> {
    const rows = await this.sql`
      select id, name, repository, status, config, created_at, updated_at
      from factory.projects
      where id = ${id}::uuid
      limit 1
    ` as unknown as ProjectRow[];
    return rows[0] ? hydrate(rows[0]) : undefined;
  }

  async list(): Promise<ProjectRecord[]> {
    const rows = await this.sql`
      select id, name, repository, status, config, created_at, updated_at
      from factory.projects
      order by created_at desc
    ` as unknown as ProjectRow[];
    return rows.map(hydrate);
  }

  async upsert(project: ProjectRecord): Promise<void> {
    const parsed = ProjectRecordSchema.parse(project);
    await this.sql`
      insert into factory.projects (
        id, name, repository, status, config, created_at, updated_at
      )
      values (
        ${parsed.id}::uuid,
        ${parsed.name},
        ${parsed.repository},
        ${parsed.status},
        ${JSON.stringify(parsed.config)}::jsonb,
        ${parsed.createdAt}::timestamptz,
        ${parsed.updatedAt}::timestamptz
      )
      on conflict (id) do update set
        name = excluded.name,
        repository = excluded.repository,
        status = excluded.status,
        config = excluded.config,
        updated_at = excluded.updated_at
    `;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

let productionProjectStore: PostgresProjectStore | undefined;

export function getProductionProjectStore(): PostgresProjectStore {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  productionProjectStore ??= new PostgresProjectStore(connectionString);
  return productionProjectStore;
}
