import { getProductionTaskStore } from "../src/store/postgres-task-store.js";

export async function GET(): Promise<Response> {
  if (process.env.VERCEL_ENV !== "preview") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const tasks = await getProductionTaskStore().list();
    return Response.json(
      { ok: true, database: "connected", taskCount: tasks.length },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ ok: false, database: "unavailable" }, { status: 503 });
  }
}
