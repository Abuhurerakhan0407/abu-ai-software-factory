import { describe, expect, it } from "vitest";
import { assertTransition, canTransition } from "../src/mission-control/state-machine.js";

describe("task state machine", () => {
  it("allows normal intake progression", () => {
    expect(canTransition("received", "triaged")).toBe(true);
    expect(canTransition("triaged", "planned")).toBe(true);
  });

  it("prevents skipping directly to production", () => {
    expect(canTransition("received", "deploying")).toBe(false);
    expect(() => assertTransition("received", "deploying")).toThrow(/Illegal task transition/);
  });
});
