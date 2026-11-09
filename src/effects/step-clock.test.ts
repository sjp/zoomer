import { describe, expect, it } from "vitest";
import { type StepClock, takeSteps } from "./step-clock";

describe("takeSteps", () => {
  it("carries the fractional remainder between frames", () => {
    const clock: StepClock = { acc: 0 };
    let total = 0;
    // 100 steps/s at 120 fps is 0.8333 steps per frame.
    for (let i = 0; i < 120; i++) {
      total += takeSteps(clock, 100, 1 / 120, 16);
    }
    expect(total).toBeGreaterThanOrEqual(99);
    expect(total).toBeLessThanOrEqual(100);
    expect(clock.acc).toBeGreaterThanOrEqual(0);
    expect(clock.acc).toBeLessThan(1);
  });

  it("caps a long frame and drops the excess instead of bursting later", () => {
    const clock: StepClock = { acc: 0.5 };
    expect(takeSteps(clock, 960, 10, 16)).toBe(16);
    expect(clock.acc).toBeCloseTo(0.5, 9);
    // The next normal frame gets its usual share, not a backlog.
    expect(takeSteps(clock, 240, 1 / 120, 16)).toBe(2);
  });

  it("runs nothing when paused or given nonsense", () => {
    const clock: StepClock = { acc: 0.25 };
    expect(takeSteps(clock, 0, 1 / 60, 16)).toBe(0);
    expect(takeSteps(clock, 240, 0, 16)).toBe(0);
    expect(takeSteps(clock, 240, -1, 16)).toBe(0);
    expect(clock.acc).toBe(0.25);
    expect(takeSteps(clock, Number.NaN, 1 / 60, 16)).toBe(0);
    expect(clock.acc).toBe(0);
  });
});
