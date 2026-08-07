import { randomUUID } from "node:crypto";
import type { AgentRole } from "../contracts/task.js";

export type AgentRunStatus = "running" | "succeeded" | "failed" | "cancelled";

export type AgentRunRecord = {
  id: string;
  taskId: string;
  agentRole: AgentRole;
  model?: string;
  status: AgentRunStatus;
  input: unknown;
  output?: unknown;
  costUsd: number;
  startedAt: string;
  finishedAt?: string;
};

export interface AgentRunStore {
  start(input: {
    taskId: string;
    agentRole: AgentRole;
    model?: string;
    payload: unknown;
  }): Promise<AgentRunRecord>;
  finish(
    id: string,
    status: Exclude<AgentRunStatus, "running">,
    output?: unknown,
  ): Promise<AgentRunRecord>;
}

export class MemoryAgentRunStore implements AgentRunStore {
  readonly runs = new Map<string, AgentRunRecord>();

  async start(input: {
    taskId: string;
    agentRole: AgentRole;
    model?: string;
    payload: unknown;
  }): Promise<AgentRunRecord> {
    const record: AgentRunRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      agentRole: input.agentRole,
      model: input.model,
      status: "running",
      input: input.payload,
      costUsd: 0,
      startedAt: new Date().toISOString(),
    };
    this.runs.set(record.id, record);
    return record;
  }

  async finish(
    id: string,
    status: Exclude<AgentRunStatus, "running">,
    output?: unknown,
  ): Promise<AgentRunRecord> {
    const existing = this.runs.get(id);
    if (!existing) throw new Error(`Agent run not found: ${id}`);

    const updated: AgentRunRecord = {
      ...existing,
      status,
      output,
      finishedAt: new Date().toISOString(),
    };
    this.runs.set(id, updated);
    return updated;
  }
}
