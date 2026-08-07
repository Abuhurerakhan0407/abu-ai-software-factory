import postgres from "postgres";
import type { AgentRole } from "../contracts/task.js";
import type {
  AgentRunRecord,
  AgentRunStatus,
  AgentRunStore,
} from "./agent-run-store.js";

type AgentRunRow = {
  id: string;
  task_id: string;
  agent_role: string;
  model: string | null;
  status: AgentRunStatus;
  input: unknown;
  output: unknown;
  cost_usd: number | string;
  started_at: Date | string;
  finished_at: Date | string | null;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function hydrate(row: AgentRunRow): AgentRunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    agentRole: row.agent_role as AgentRole,
    model: row.model ?? undefined,
    status: row.status,
    input: row.input,
    output: row.output ?? undefined,
    costUsd: Number(row.cost_usd),
    startedAt: iso(row.started_at),
    finishedAt: row.finished_at ? iso(row.finished_at) : undefined,
  };
}

export class PostgresAgentRunStore implements AgentRunStore {
  private readonly sql: ReturnType<typeof postgres>;

  constructor(connectionString: string) {
    if (!connectionString) throw new Error("DATABASE_URL is required");
    this.sql = postgres(connectionString, {
      max: 2,
      prepare: false,
      ssl: "require",
      connection: {
        application_name: "abu-ai-software-factory-runs",
      },
    });
  }

  async start(input: {
    taskId: string;
    agentRole: AgentRole;
    model?: string;
    payload: unknown;
  }): Promise<AgentRunRecord> {
    const rows = await this.sql`
      insert into factory.agent_runs (
        task_id, agent_role, model, status, input
      )
      values (
        ${input.taskId}::uuid,
        ${input.agentRole},
        ${input.model ?? null},
        'running',
        ${JSON.stringify(input.payload ?? null)}::jsonb
      )
      returning
        id, task_id, agent_role, model, status, input, output,
        cost_usd, started_at, finished_at
    ` as unknown as AgentRunRow[];

    if (!rows[0]) throw new Error("Failed to create agent run");
    return hydrate(rows[0]);
  }

  async finish(
    id: string,
    status: Exclude<AgentRunStatus, "running">,
    output?: unknown,
  ): Promise<AgentRunRecord> {
    const rows = await this.sql`
      update factory.agent_runs
      set
        status = ${status},
        output = ${JSON.stringify(output ?? null)}::jsonb,
        finished_at = now()
      where id = ${id}::uuid
      returning
        id, task_id, agent_role, model, status, input, output,
        cost_usd, started_at, finished_at
    ` as unknown as AgentRunRow[];

    if (!rows[0]) throw new Error(`Agent run not found: ${id}`);
    return hydrate(rows[0]);
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

let productionRunStore: PostgresAgentRunStore | undefined;

export function getProductionAgentRunStore(): PostgresAgentRunStore {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  productionRunStore ??= new PostgresAgentRunStore(connectionString);
  return productionRunStore;
}
