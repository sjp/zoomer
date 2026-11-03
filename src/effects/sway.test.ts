import { describe, expect, it } from "vitest";
import {
  advanceSwell,
  createSwell,
  DEFAULT_SWELL,
  swayAt,
  swayGlsl,
  swayOffset,
  swellAt,
} from "./sway";

describe("createSwell", () => {
  it("rejects waves that would not wrap seamlessly", () => {
    expect(() => createSwell(10, [{ cycles: 1.5, amplitude: 1, offset: 0 }])).toThrow(
      "cycles must be a positive integer",
    );
    expect(() => createSwell(10, [{ cycles: 0, amplitude: 1, offset: 0 }])).toThrow(
      "cycles must be a positive integer",
    );
    expect(() => createSwell(0, [{ cycles: 1, amplitude: 1, offset: 0 }])).toThrow(
      "period must be positive",
    );
    expect(() => createSwell(10, [])).toThrow("at least one wave");
    expect(() => createSwell(10, [{ cycles: 1, amplitude: 0, offset: 0 }])).toThrow("sum to zero");
  });

  it("normalises by the summed amplitudes", () => {
    const s = createSwell(10, [
      { cycles: 1, amplitude: 2, offset: 0 },
      { cycles: 2, amplitude: -2, offset: 0 },
    ]);
    expect(s.norm).toBeCloseTo(0.25);
  });
});

describe("swellAt", () => {
  it("stays within [-1, 1] and wraps at phase 1", () => {
    for (let i = 0; i <= 1000; i++) {
      const p = i / 1000;
      expect(Math.abs(swellAt(DEFAULT_SWELL, p))).toBeLessThanOrEqual(1);
    }
    expect(swellAt(DEFAULT_SWELL, 0)).toBeCloseTo(swellAt(DEFAULT_SWELL, 1), 9);
    expect(swellAt(DEFAULT_SWELL, 0.3)).toBeCloseTo(swellAt(DEFAULT_SWELL, -0.7), 9);
  });

  it("actually moves", () => {
    let lo = 1;
    let hi = -1;
    for (let i = 0; i < 600; i++) {
      const s = swellAt(DEFAULT_SWELL, i / 600);
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
    expect(hi - lo).toBeGreaterThan(1);
  });
});

describe("advanceSwell", () => {
  it("advances by dt * speed / period and wraps", () => {
    expect(advanceSwell(DEFAULT_SWELL, 0, 6)).toBeCloseTo(0.1);
    expect(advanceSwell(DEFAULT_SWELL, 0, 6, 2)).toBeCloseTo(0.2);
    expect(advanceSwell(DEFAULT_SWELL, 0.95, 6)).toBeCloseTo(0.05);
  });

  it("ignores negative and non-finite steps", () => {
    expect(advanceSwell(DEFAULT_SWELL, 0.4, -1)).toBe(0.4);
    expect(advanceSwell(DEFAULT_SWELL, 0.4, Number.NaN)).toBe(0.4);
    expect(advanceSwell(DEFAULT_SWELL, 0.4, 1, 0)).toBe(0.4);
  });

  it("is continuous across the wrap", () => {
    let phase = 0.999;
    const before = swellAt(DEFAULT_SWELL, phase);
    phase = advanceSwell(DEFAULT_SWELL, phase, 0.12);
    expect(phase).toBeLessThan(0.01);
    expect(Math.abs(swellAt(DEFAULT_SWELL, phase) - before)).toBeLessThan(0.05);
  });
});

describe("swayOffset", () => {
  it("is zero at the base", () => {
    for (let i = 0; i < 50; i++) {
      expect(Math.abs(swayOffset(DEFAULT_SWELL, i / 50, 0, 3, 40))).toBe(0);
    }
  });

  it("is bounded by the amplitude", () => {
    for (let i = 0; i < 200; i++) {
      for (let t = 0; t <= 1.5; t += 0.1) {
        expect(Math.abs(swayOffset(DEFAULT_SWELL, i / 200, t, 4, 25))).toBeLessThanOrEqual(25);
      }
    }
  });

  it("is continuous in time", () => {
    const dt = 1 / 120;
    let phase = 0;
    let prev = swayOffset(DEFAULT_SWELL, phase, 1, 3, 1);
    for (let i = 0; i < 120 * 70; i++) {
      phase = advanceSwell(DEFAULT_SWELL, phase, dt);
      const next = swayOffset(DEFAULT_SWELL, phase, 1, 3, 1);
      expect(Math.abs(next - prev)).toBeLessThan(0.01);
      prev = next;
    }
  });

  it("makes the tip trail the base by the lag", () => {
    const lag = 2;
    const phase = 0.37;
    const later = phase + lag / DEFAULT_SWELL.period;
    // The tip now shows what a lag-free stem showed `lag` seconds ago.
    expect(swayOffset(DEFAULT_SWELL, later, 1, lag)).toBeCloseTo(
      swayOffset(DEFAULT_SWELL, phase, 1, 0),
      9,
    );
    expect(swayAt(DEFAULT_SWELL, later, lag)).toBeCloseTo(swellAt(DEFAULT_SWELL, phase), 9);
  });
});

describe("swayGlsl", () => {
  it("names its functions and bakes in every wave", () => {
    const src = swayGlsl(DEFAULT_SWELL, "kelp");
    expect(src).toContain("float kelpSwell(float phase)");
    expect(src).toContain("float kelpAt(float phase, float lag)");
    expect(src).toContain("float kelpOffset(float phase, float t, float lag)");
    expect(src.match(/sin\(/g)).toHaveLength(DEFAULT_SWELL.waves.length);
    expect(swayGlsl(DEFAULT_SWELL)).toContain("float swayOffset(");
  });
});
