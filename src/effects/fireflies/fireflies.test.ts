import { describe, expect, it } from "vitest";
import { blink } from "./fireflies";

describe("blink", () => {
  it("is dark outside the pulse", () => {
    expect(blink(0, 0.2)).toBe(0);
    expect(blink(0.2, 0.2)).toBe(0);
    expect(blink(0.5, 0.2)).toBe(0);
    expect(blink(0.99, 0.2)).toBe(0);
    expect(blink(-0.1, 0.2)).toBe(0);
    expect(blink(0.1, 0)).toBe(0);
  });

  it("peaks at 1 mid-pulse and is symmetric", () => {
    expect(blink(0.1, 0.2)).toBeCloseTo(1, 10);
    expect(blink(0.05, 0.2)).toBeCloseTo(blink(0.15, 0.2), 10);
    expect(blink(0.05, 0.2)).toBeCloseTo(0.5, 10);
  });

  it("fades in and out smoothly (near-zero slope at the ends)", () => {
    const eps = 1e-4;
    expect(blink(eps, 0.2)).toBeLessThan(1e-5);
    expect(blink(0.2 - eps, 0.2)).toBeLessThan(1e-5);
  });

  it("stays in [0, 1]", () => {
    for (let ph = 0; ph < 1; ph += 0.01) {
      const v = blink(ph, 0.3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
