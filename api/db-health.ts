import { getProductionTaskStore } from "../src/store/postgres-task-store.js";

function safeErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "UNKNOWN";
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
    ? code
    : "UNKNOWN";
}

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
  } catch (error) {
    const code = safeErrorCode(error);
    console.error("[db-health] connection failed", { code });
    return Response.json(
      { ok: false, database: "unavailable", code },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
