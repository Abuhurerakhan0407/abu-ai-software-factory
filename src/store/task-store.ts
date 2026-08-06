import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TaskRecordSchema, type TaskRecord } from "../contracts/task.js";

export interface TaskStore {
  get(id: string): Promise<TaskRecord | undefined>;
  list(): Promise<TaskRecord[]>;
  upsert(task: TaskRecord): Promise<void>;
}

export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();

  async get(id: string): Promise<TaskRecord | undefined> {
    return this.tasks.get(id);
  }

  async list(): Promise<TaskRecord[]> {
    return [...this.tasks.values()];
  }

  async upsert(task: TaskRecord): Promise<void> {
    this.tasks.set(task.id, TaskRecordSchema.parse(task));
  }
}

export class JsonTaskStore implements TaskStore {
  constructor(private readonly path: string) {}

  private async load(): Promise<TaskRecord[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      return TaskRecordSchema.array().parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    return (await this.load()).find((task) => task.id === id);
  }

  async list(): Promise<TaskRecord[]> {
    return this.load();
  }

  async upsert(task: TaskRecord): Promise<void> {
    const parsed = TaskRecordSchema.parse(task);
    const tasks = await this.load();
    const index = tasks.findIndex((item) => item.id === parsed.id);
    if (index >= 0) tasks[index] = parsed;
    else tasks.push(parsed);

    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(tasks, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.path);
  }
}
