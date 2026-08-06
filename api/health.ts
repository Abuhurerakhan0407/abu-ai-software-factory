export function GET(): Response {
  return Response.json(
    {
      ok: true,
      service: "abu-ai-software-factory",
      status: "ready",
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
