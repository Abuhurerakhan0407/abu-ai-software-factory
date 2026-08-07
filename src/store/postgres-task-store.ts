import postgres from "postgres";
import { TaskRecordSchema, type TaskRecord } from "../contracts/task.js";
import type { TaskStore } from "./task-store.js";

type TaskRow = {
  id: string;
  project_id: string | null;
  title: string;
  description: string;
  requested_by: string;
  category: string;
  assigned_agent: string;
  risk_level: string;
  status: string;
  plan: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

type AuditRow = {
  actor: string;
  event_type: string;
  details: unknown;
  created_at: Date | string;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function auditDetail(details: unknown): string {
  const decoded = decodeJson(details);
  if (
    typeof decoded === "object"
    && decoded !== null
    && "detail" in decoded
    && typeof (decoded as { detail?: unknown }).detail === "string"
  ) {
    return (decoded as { detail: string }).detail;
  }
  return "No detail recorded";
}

export class PostgresTaskStore implements TaskStore {
  private readonly sql: ReturnType<typeof postgres>;

  constructor(connectionString: string) {
    if (!connectionString) throw new Error("DATABASE_URL is required");
    this.sql = postgres(connectionString, {
      max: 3,
      prepare: false,
      ssl: "require",
      connection: {
        application_name: "abu-ai-software-factory",
      },
    });
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    const rows = await this.sql`
      select
        id, project_id, title, description, requested_by, category, assigned_agent,
        risk_level, status, plan, created_at, updated_at
      from factory.tasks
      where id = ${id}::uuid
      limit 1
    ` as unknown as TaskRow[];

    if (!rows[0]) return undefined;
    return this.hydrate(rows[0]);
  }

  async list(): Promise<TaskRecord[]> {
    const rows = await this.sql`
      select
        id, project_id, title, description, requested_by, category, assigned_agent,
        risk_level, status, plan, created_at, updated_at
      from factory.tasks
      order by created_at desc
    ` as unknown as TaskRow[];

    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  async upsert(task: TaskRecord): Promise<void> {
    const parsed = TaskRecordSchema.parse(task);

    await this.sql.begin(async (tx) => {
      await tx`
        insert into factory.tasks (
          id, project_id, title, description, requested_by, category, assigned_agent,
          risk_level, status, plan, created_at, updated_at
        )
        values (
          ${parsed.id}::uuid,
          ${parsed.projectId ?? null}::uuid,
          ${parsed.title},
          ${parsed.description},
          ${parsed.requestedBy},
          ${parsed.category},
          ${parsed.assignedAgent},
          ${parsed.risk},
          ${parsed.status},
          ${parsed.plan}::jsonb,
          ${parsed.createdAt}::timestamptz,
          ${parsed.updatedAt}::timestamptz
        )
        on conflict (id) do update set
          project_id = excluded.project_id,
          title = excluded.title,
          description = excluded.description,
          requested_by = excluded.requested_by,
          category = excluded.category,
          assigned_agent = excluded.assigned_agent,
          risk_level = excluded.risk_level,
          status = excluded.status,
          plan = excluded.plan,
          updated_at = excluded.updated_at
      `;

      const countRows = await tx`
        select count(*)::int as count
        from factory.audit_events
        where task_id = ${parsed.id}::uuid
      ` as unknown as Array<{ count: number }>;

      const existing = Number(countRows[0]?.count ?? 0);
      for (const event of parsed.audit.slice(existing)) {
        await tx`
          insert into factory.audit_events (
            task_id, actor, event_type, details, created_at
          )
          values (
            ${parsed.id}::uuid,
            ${event.actor},
            ${event.event},
            ${{ detail: event.detail }}::jsonb,
            ${event.at}::timestamptz
          )
        `;
      }
    });
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  private async hydrate(row: TaskRow): Promise<TaskRecord> {
    const auditRows = await this.sql`
      select actor, event_type, details, created_at
      from factory.audit_events
      where task_id = ${row.id}::uuid
      order by created_at asc, id asc
    ` as unknown as AuditRow[];

    return TaskRecordSchema.parse({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      requestedBy: row.requested_by,
      category: row.category,
      assignedAgent: row.assigned_agent,
      risk: row.risk_level,
      status: row.status,
      plan: decodeJson(row.plan ?? []),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      audit: auditRows.map((event) => ({
        at: iso(event.created_at),
        actor: event.actor,
        event: event.event_type,
        detail: auditDetail(event.details),
      })),
    });
  }
}

let productionStore: PostgresTaskStore | undefined;

export function getProductionTaskStore(): PostgresTaskStore {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  productionStore ??= new PostgresTaskStore(connectionString);
  return productionStore;
}
