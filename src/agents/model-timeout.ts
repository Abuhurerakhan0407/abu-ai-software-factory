const DEFAULT_AGENT_MODEL_TIMEOUT_MS = 40_000;

export class AgentModelTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(label + " model call timed out after " + timeoutMs + "ms");
    this.name = "AgentModelTimeoutError";
  }
}

export async function withAgentModelTimeout<T>(
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = DEFAULT_AGENT_MODEL_TIMEOUT_MS,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Agent model timeout must be positive");
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AgentModelTimeoutError(label, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      operation(controller.signal),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
