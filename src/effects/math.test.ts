import { describe, expect, it } from "vitest";
import { approach, clamp, fract, smoothstep, wrap } from "./math";

describe("clamp", () => {
  it("limits to the range", () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(0.25, 0, 1)).toBe(0.25);
    expect(clamp(3, 0, 1)).toBe(1);
  });
});

describe("approach", () => {
  it("steps towards the target without overshooting", () => {
    expect(approach(0, 1, 0.25)).toBe(0.25);
    expect(approach(1, 0, 0.25)).toBe(0.75);
    expect(approach(0.9, 1, 0.25)).toBe(1);
    expect(approach(0.1, 0, 0.25)).toBe(0);
    expect(approach(0.5, 0.5, 0.25)).toBe(0.5);
  });
});

describe("smoothstep", () => {
  it("matches GLSL", () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(2, 4, 2.5)).toBeCloseTo(0.15625, 12);
  });

  it("supports reversed edges", () => {
    expect(smoothstep(1, 0, 0)).toBe(1);
    expect(smoothstep(1, 0, 1)).toBe(0);
    expect(smoothstep(1, 0, 0.25)).toBeCloseTo(1 - smoothstep(0, 1, 0.25), 12);
  });
});

describe("fract", () => {
  it("keeps the fractional part, positive for negative inputs", () => {
    expect(fract(2.25)).toBe(0.25);
    expect(fract(-0.25)).toBe(0.75);
    expect(fract(3)).toBe(0);
  });
});

describe("wrap", () => {
  it("wraps into [lo, lo + span)", () => {
    expect(wrap(5, 0, 10)).toBe(5);
    expect(wrap(12, 0, 10)).toBe(2);
    expect(wrap(-3, 0, 10)).toBe(7);
    expect(wrap(10, 0, 10)).toBe(0);
    expect(wrap(0, 0, 10)).toBe(0);
    expect(wrap(25, -5, 10)).toBe(-5);
    expect(wrap(-17, -5, 10)).toBe(3);
  });

  it("handles values many spans away", () => {
    expect(wrap(1e6 + 3, 0, 10)).toBe(3);
    expect(wrap(-1e6 - 3, 0, 10)).toBe(7);
  });

  it("returns in-range values unchanged and moves every other value", () => {
    for (const v of [-200, -100, -0.5, 0, 1919.99, 2020, 2021, 5000]) {
      const w = wrap(v, -100, 2120);
      expect(w).toBeGreaterThanOrEqual(-100);
      expect(w).toBeLessThan(2020);
      expect(w !== v).toBe(v < -100 || v >= 2020);
    }
  });

  it("never returns the upper bound after rounding", () => {
    const w = wrap(-1e-17, 0, 1);
    expect(w).toBeGreaterThanOrEqual(0);
    expect(w).toBeLessThan(1);
  });
});
