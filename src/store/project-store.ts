import {
  ProjectRecordSchema,
  type ProjectRecord,
} from "../contracts/project.js";

export interface ProjectStore {
  get(id: string): Promise<ProjectRecord | undefined>;
  list(): Promise<ProjectRecord[]>;
  upsert(project: ProjectRecord): Promise<void>;
}

export class MemoryProjectStore implements ProjectStore {
  readonly projects = new Map<string, ProjectRecord>();

  async get(id: string): Promise<ProjectRecord | undefined> {
    return this.projects.get(id);
  }

  async list(): Promise<ProjectRecord[]> {
    return [...this.projects.values()];
  }

  async upsert(project: ProjectRecord): Promise<void> {
    const parsed = ProjectRecordSchema.parse(project);
    this.projects.set(parsed.id, parsed);
  }
}
