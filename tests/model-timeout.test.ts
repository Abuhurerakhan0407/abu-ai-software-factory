import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentModelTimeoutError,
  withAgentModelTimeout,
} from "../src/agents/model-timeout.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("withAgentModelTimeout", () => {
  it("returns successful model output", async () => {
    await expect(withAgentModelTimeout(
      "Test worker",
      async (signal) => {
        expect(signal.aborted).toBe(false);
        return "complete";
      },
      100,
    )).resolves.toBe("complete");
  });

  it("aborts and rejects a stalled model call", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const pending = withAgentModelTimeout(
      "Test worker",
      async (signal) => {
        capturedSignal = signal;
        return new Promise<string>(() => undefined);
      },
      100,
    );
    const assertion = expect(pending).rejects.toEqual(
      new AgentModelTimeoutError("Test worker", 100),
    );

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(capturedSignal?.aborted).toBe(true);
  });
});
