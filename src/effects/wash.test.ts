import { describe, expect, it } from "vitest";
import { T_ACTIVE, T_APPROACH, T_STOP, washFront, washSinceUncovered } from "./wash";

describe("washFront", () => {
  const [reach, brk, approach] = [0.2, 0.08, 1.2];

  it("starts at the approach distance, breaks, tops out at reach and ends at 0", () => {
    expect(washFront(0, reach, brk, approach)).toBeCloseTo(-approach);
    expect(washFront(-5, reach, brk, approach)).toBeCloseTo(-approach);
    expect(washFront(T_APPROACH, reach, brk, approach)).toBeCloseTo(-brk);
    expect(washFront(T_STOP, reach, brk, approach)).toBeCloseTo(reach);
    expect(washFront(T_ACTIVE, reach, brk, approach)).toBe(0);
    expect(washFront(T_ACTIVE + 50, reach, brk, approach)).toBe(0);
  });

  it("is continuous and bounded", () => {
    let prev = washFront(0, reach, brk, approach);
    for (let t = 0.001; t < T_ACTIVE + 1; t += 0.001) {
      const v = washFront(t, reach, brk, approach);
      expect(Math.abs(v - prev)).toBeLessThan(0.002);
      expect(v).toBeGreaterThanOrEqual(-approach - 1e-9);
      expect(v).toBeLessThanOrEqual(reach + 1e-9);
      prev = v;
    }
  });
});

describe("washSinceUncovered", () => {
  it("is zero when the draining front passes n", () => {
    const reach = 0.2;
    for (const n of [0.02, 0.1, 0.19]) {
      // Find when the front drops below n while draining.
      let t = T_STOP;
      while (washFront(t, reach, 0.05, 1) > n) t += 1e-4;
      expect(washSinceUncovered(n, t, reach)).toBeCloseTo(0, 3);
    }
  });

  it("is negative while still covered", () => {
    expect(washSinceUncovered(0, T_STOP, 0.2)).toBeLessThan(0);
  });
});
