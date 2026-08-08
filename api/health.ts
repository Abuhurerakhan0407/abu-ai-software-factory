const coreRuntimeReady = () => Boolean(
  process.env.DATABASE_URL
  && process.env.FACTORY_API_TOKEN
  && process.env.OPENROUTER_API_KEY
  && process.env.GITHUB_CONNECTOR_ID
);

export function GET(): Response {
  const coreRuntime = coreRuntimeReady();
  const productionApproval = Boolean(process.env.FACTORY_APPROVAL_TOKEN);
  const productionMonitoring = Boolean(
    process.env.VERCEL_AUTOMATION_TOKEN
    && process.env.VERCEL_TEAM_ID
  );
  const explicitAiModel = Boolean(process.env.MISSION_CONTROL_MODEL);
  const productionReady = Boolean(
    coreRuntime
    && productionApproval
    && productionMonitoring
    && explicitAiModel
  );

  return Response.json(
    {
      ok: coreRuntime,
      service: "abu-ai-software-factory",
      status: coreRuntime ? "ready" : "degraded",
      productionReady,
      checks: {
        coreRuntime,
        productionApproval,
        productionMonitoring,
        explicitAiModel,
      },
    },
    {
      status: coreRuntime ? 200 : 503,
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
