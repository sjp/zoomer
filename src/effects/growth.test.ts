import { describe, expect, it } from "vitest";
import {
  createGrowthClock,
  cyclePeriod,
  growthCover,
  growthStateAt,
  growthThreshold,
  GROWTH_GLSL,
  meltOffset,
  segmentReveal,
  type GrowthState,
} from "./growth";

const CYCLE = { grow: 100, hold: 40, melt: 60 };
const MAX_BIAS = 1.5;

/** Coverage of a part with this arrival and bias in state `s`. */
function cover(s: GrowthState, arrival: number, bias: number, soft = 0.1): number {
  return growthCover(arrival, growthThreshold(s.level, meltOffset(s.melt, MAX_BIAS), bias), soft);
}

describe("cyclePeriod", () => {
  it("sums the phases and rejects bad durations", () => {
    expect(cyclePeriod(CYCLE)).toBe(200);
    expect(cyclePeriod({ grow: 1, hold: 0, melt: 1 })).toBe(2);
    expect(() => cyclePeriod({ grow: 0, hold: 1, melt: 1 })).toThrow("growth:");
    expect(() => cyclePeriod({ grow: 1, hold: -1, melt: 1 })).toThrow("growth:");
    expect(() => cyclePeriod({ grow: 1, hold: 1, melt: Number.NaN })).toThrow("growth:");
    expect(() => cyclePeriod({ grow: 1, hold: Infinity, melt: 1 })).toThrow("growth:");
  });
});

describe("growthStateAt", () => {
  it("grows, holds, melts and wraps", () => {
    expect(growthStateAt(CYCLE, 0)).toMatchObject({ phase: "grow", cycle: 0, level: 0, melt: 0 });
    expect(growthStateAt(CYCLE, 50)).toMatchObject({ phase: "grow", level: 0.5, melt: 0 });
    expect(growthStateAt(CYCLE, 120)).toMatchObject({ phase: "hold", level: 1, melt: 0 });
    expect(growthStateAt(CYCLE, 170)).toMatchObject({ phase: "melt", level: 1, melt: 0.5 });
    expect(growthStateAt(CYCLE, 200)).toMatchObject({ phase: "grow", cycle: 1, level: 0 });
    expect(growthStateAt(CYCLE, 2000 + 50)).toMatchObject({ cycle: 10, level: 0.5 });
  });

  it("treats negative and non-finite times as 0", () => {
    expect(growthStateAt(CYCLE, -5)).toMatchObject({ cycle: 0, level: 0 });
    expect(growthStateAt(CYCLE, Number.NaN)).toMatchObject({ cycle: 0, level: 0 });
  });

  it("keeps level and melt in [0, 1] and time in [0, period)", () => {
    for (let t = 0; t < 1000; t += 0.37) {
      const s = growthStateAt(CYCLE, t);
      expect(s.level).toBeGreaterThanOrEqual(0);
      expect(s.level).toBeLessThanOrEqual(1);
      expect(s.melt).toBeGreaterThanOrEqual(0);
      expect(s.melt).toBeLessThanOrEqual(1);
      expect(s.time).toBeGreaterThanOrEqual(0);
      expect(s.time).toBeLessThan(200);
    }
  });

  it("is continuous: coverage changes by little per small step, wrap included", () => {
    const arrivals = [0, 0.1, 0.5, 0.9, 0.99];
    const biases = [0, 0.4, MAX_BIAS];
    const a = growthStateAt(CYCLE, 0);
    const b = growthStateAt(CYCLE, 0);
    for (let t = 0; t < 600; t += 0.05) {
      growthStateAt(CYCLE, t, a);
      growthStateAt(CYCLE, t + 0.05, b);
      for (const arr of arrivals) {
        for (const bias of biases) {
          expect(Math.abs(cover(a, arr, bias) - cover(b, arr, bias))).toBeLessThan(0.05);
        }
      }
    }
  });

  it("shows nothing on either side of the wrap, so a reseed is invisible", () => {
    const end = growthStateAt(CYCLE, 200 - 1e-9);
    const start = growthStateAt(CYCLE, 200);
    expect(end.cycle).toBe(0);
    expect(start.cycle).toBe(1);
    for (const arr of [0, 0.3, 1]) {
      for (const bias of [0, 0.7, MAX_BIAS]) {
        expect(cover(end, arr, bias)).toBeLessThan(1e-9);
        expect(cover(start, arr, bias)).toBe(0);
      }
    }
  });

  it("melts parts with a small bias first", () => {
    const s = growthStateAt(CYCLE, 140 + 20);
    expect(cover(s, 0.5, 0)).toBe(0);
    expect(cover(s, 0.5, MAX_BIAS)).toBe(1);
  });
});

describe("createGrowthClock", () => {
  it("advances by dt * speed and ignores bad steps", () => {
    const clock = createGrowthClock(CYCLE, 10);
    clock.advance(5, 2);
    expect(clock.time).toBe(20);
    clock.advance(-1);
    clock.advance(Number.NaN);
    clock.advance(1, Number.POSITIVE_INFINITY);
    expect(clock.time).toBe(20);
    expect(clock.state.level).toBeCloseTo(0.2);
  });

  it("reuses one state object", () => {
    const clock = createGrowthClock(CYCLE);
    expect(clock.advance(1)).toBe(clock.state);
  });

  it("without looping, grows to the hold and stays", () => {
    const clock = createGrowthClock(CYCLE, 90);
    for (let i = 0; i < 100; i++) clock.advance(1, 1, false);
    expect(clock.time).toBe(100);
    expect(clock.state).toMatchObject({ phase: "hold", level: 1, melt: 0, cycle: 0 });
  });

  it("without looping, runs a melt backwards to the hold, then resumes", () => {
    const clock = createGrowthClock(CYCLE, 1000 + 170);
    expect(clock.state).toMatchObject({ cycle: 5, phase: "melt" });
    let melt = clock.state.melt;
    for (let i = 0; i < 200; i++) {
      clock.advance(0.5, 1, false);
      expect(clock.state.melt).toBeLessThanOrEqual(melt);
      melt = clock.state.melt;
    }
    expect(clock.state).toMatchObject({ cycle: 5, level: 1, melt: 0 });
    clock.advance(100);
    expect(clock.state).toMatchObject({ cycle: 6, phase: "grow" });
  });
});

describe("segmentReveal", () => {
  it("extends from the start at the segment's speed", () => {
    expect(segmentReveal(0.2, 0.4, 0.1)).toBe(0);
    expect(segmentReveal(0.2, 0.4, 0.3)).toBeCloseTo(0.5);
    expect(segmentReveal(0.2, 0.4, 0.5)).toBe(1);
    expect(segmentReveal(0.2, 0.2, 0.19)).toBe(0);
    expect(segmentReveal(0.2, 0.2, 0.21)).toBe(1);
  });
});

describe("GROWTH_GLSL", () => {
  it("defines the three twins", () => {
    expect(GROWTH_GLSL).toContain("float growthThreshold(vec2 growth, float bias)");
    expect(GROWTH_GLSL).toContain("float growthCover(float arrival, float threshold, float soft)");
    expect(GROWTH_GLSL).toContain("float segmentReveal(float t0, float t1, float threshold)");
  });
});
