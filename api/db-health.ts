import { getProductionTaskStore } from "../src/store/postgres-task-store.js";

export async function GET(): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return Response.json(
      { ok: false, database: "not_configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    await getProductionTaskStore().list();
    return Response.json(
      { ok: true, database: "connected" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, database: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
