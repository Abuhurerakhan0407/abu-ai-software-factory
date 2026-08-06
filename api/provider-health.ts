import { createMissionPlan } from "../src/ai/planner.js";

export async function GET(): Promise<Response> {
  if (process.env.VERCEL_ENV !== "preview") {
    return new Response("Not found", { status: 404 });
  }

  try {
    await createMissionPlan("Plan a no-op system health verification task.");
    return Response.json(
      { ok: true, provider: "openrouter", model: process.env.MISSION_CONTROL_MODEL ?? "openrouter/free" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, error: "provider_unavailable" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
