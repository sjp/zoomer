import { describe, expect, it } from "vitest";
import {
  advanceDrift,
  DRIFT_PERIOD,
  driftedFeedKill,
  grayScottStep,
  LAP_CORNER,
  LAP_EDGE,
  makeSpots,
  pack16,
  PATTERN_OPTIONS,
  type Preset,
  PRESETS,
  presetFor,
  SPOT_B,
  SPOT_COUNT,
  SPOT_U,
  type StepClock,
  takeSteps,
  unpack16,
} from "./reaction-sim";

const presets = Object.entries(PRESETS) as [string, Preset][];

describe("presets", () => {
  it.each(presets)("%s has F and k in the patterned range, drift included", (_, p) => {
    const out = new Float64Array(2);
    for (let i = 0; i < 64; i++) {
      driftedFeedKill(p, 1, (i / 64) * Math.PI * 2, out);
      expect(out[0]).toBeGreaterThan(0.01);
      expect(out[0]).toBeLessThan(0.1);
      expect(out[1]).toBeGreaterThan(0.045);
      expect(out[1]).toBeLessThan(0.07);
    }
    // The drift stays a small wander, not a jump to another family.
    expect(p.driftFeed).toBeLessThanOrEqual(p.feed * 0.1);
    expect(p.driftKill).toBeLessThanOrEqual(p.kill * 0.02);
  });

  it("lists every preset as a select option, and falls back to coral", () => {
    expect(PATTERN_OPTIONS.map((o) => o.value)).toEqual(Object.keys(PRESETS));
    expect(presetFor("labyrinth")).toBe(PRESETS.labyrinth);
    expect(presetFor("nope")).toBe(PRESETS.coral);
    expect(presetFor("toString")).toBe(PRESETS.coral);
  });

  it.each(presets)("%s grows from a seed and sustains a pattern at the drift extremes", (_, p) => {
    const w = 40;
    const h = 40;
    const fk = new Float64Array(2);
    for (const phase of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      driftedFeedKill(p, 1, phase, fk);
      let u = new Float32Array(w * h);
      let b = new Float32Array(w * h);
      let u2 = new Float32Array(w * h);
      let b2 = new Float32Array(w * h);
      for (let y = 17; y < 23; y++) {
        for (let x = 17; x < 23; x++) {
          u[y * w + x] = SPOT_U;
          b[y * w + x] = SPOT_B;
        }
      }
      for (let s = 0; s < 2500; s++) {
        grayScottStep(u, b, w, h, fk[0], fk[1], u2, b2);
        [u, u2] = [u2, u];
        [b, b2] = [b2, b];
      }
      let cells = 0;
      let max = 0;
      for (const v of b) {
        if (v > 0.1) cells++;
        max = Math.max(max, v);
      }
      // Alive (not decayed to the blank state) and spread well past the 36-cell seed.
      expect(max).toBeGreaterThan(0.25);
      expect(cells).toBeGreaterThan(60);
    }
  });
});

describe("drift path", () => {
  it("is closed: one period returns to the start", () => {
    const p = PRESETS.coral;
    const a = new Float64Array(2);
    const b = new Float64Array(2);
    driftedFeedKill(p, 1, 0, a);
    let phase = 0;
    const dt = 1 / 60;
    for (let t = 0; t < DRIFT_PERIOD * 60; t++) phase = advanceDrift(phase, dt);
    driftedFeedKill(p, 1, phase, b);
    expect(b[0]).toBeCloseTo(a[0], 6);
    expect(b[1]).toBeCloseTo(a[1], 6);
  });

  it("is continuous, including across the phase wrap", () => {
    const p = PRESETS.stripes;
    const prev = new Float64Array(2);
    const next = new Float64Array(2);
    let phase = advanceDrift(0, DRIFT_PERIOD - 0.5);
    driftedFeedKill(p, 1, phase, prev);
    for (let i = 0; i < 120; i++) {
      phase = advanceDrift(phase, 1 / 60);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(Math.PI * 2);
      driftedFeedKill(p, 1, phase, next);
      expect(Math.abs(next[0] - prev[0])).toBeLessThan(1e-5);
      expect(Math.abs(next[1] - prev[1])).toBeLessThan(1e-5);
      prev.set(next);
    }
  });

  it("sits at the preset with no drift", () => {
    const out = new Float64Array(2);
    driftedFeedKill(PRESETS.mitosis, 0, 1.234, out);
    expect([...out]).toEqual([PRESETS.mitosis.feed, PRESETS.mitosis.kill]);
  });
});

describe("takeSteps", () => {
  it("carries the fractional remainder between frames", () => {
    const clock: StepClock = { acc: 0 };
    let total = 0;
    // 100 steps/s at 120 fps is 0.8333 steps per frame.
    for (let i = 0; i < 120; i++) total += takeSteps(clock, 100, 1 / 120, 16);
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

describe("makeSpots", () => {
  it("is deterministic per seed and keeps spots off the middle third", () => {
    const a = new Float32Array(SPOT_COUNT * 3);
    const b = new Float32Array(SPOT_COUNT * 3);
    makeSpots(3, a);
    makeSpots(3, b);
    expect(a).toEqual(b);
    makeSpots(4, b);
    expect(a).not.toEqual(b);
    for (let i = 0; i < SPOT_COUNT; i++) {
      const x = a[i * 3];
      expect(x < 1 / 3 || x > 2 / 3).toBe(true);
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(1);
      expect(a[i * 3 + 1]).toBeGreaterThan(0);
      expect(a[i * 3 + 1]).toBeLessThan(1);
      expect(a[i * 3 + 2]).toBeGreaterThanOrEqual(3);
      expect(a[i * 3 + 2]).toBeLessThanOrEqual(6);
    }
  });
});

describe("pack16", () => {
  it("round-trips to within half a 16-bit step and clamps", () => {
    const out = new Float64Array(2);
    for (const v of [0, 1e-5, 0.1234567, 0.5, 0.99999, 1]) {
      pack16(v, out, 0);
      expect(out[0]).toBeGreaterThanOrEqual(0);
      expect(out[0]).toBeLessThanOrEqual(1);
      expect(Math.abs(unpack16(out[0], out[1]) - v)).toBeLessThanOrEqual(0.5 / 65535 + 1e-12);
    }
    pack16(2, out, 0);
    expect(unpack16(out[0], out[1])).toBe(1);
    pack16(-1, out, 0);
    expect(unpack16(out[0], out[1])).toBe(0);
  });
});

describe("grayScottStep", () => {
  it("leaves the blank state (A = 1, B = 0) blank", () => {
    const u = new Float32Array(9);
    const b = new Float32Array(9);
    const ou = new Float32Array(9).fill(7);
    const ob = new Float32Array(9).fill(7);
    grayScottStep(u, b, 3, 3, 0.05, 0.06, ou, ob);
    expect([...ou, ...ob].every((v) => v === 0)).toBe(true);
  });

  it("matches the documented update on a 3x3 grid", () => {
    // A single B cell in the middle, A = 1 everywhere (u = 0).
    const u = new Float32Array(9);
    const b = new Float32Array(9);
    b[4] = 0.5;
    const ou = new Float32Array(9);
    const ob = new Float32Array(9);
    const F = 0.05;
    const k = 0.06;
    grayScottStep(u, b, 3, 3, F, k, ou, ob);
    // Centre: lap(b) = -0.5; react = 1 * 0.25.
    expect(ob[4]).toBeCloseTo(0.5 + 0.5 * -0.5 + 0.25 - (F + k) * 0.5, 6);
    expect(ou[4]).toBeCloseTo(0.25, 6);
    // Edge neighbour: lap(b) = 0.2 * 0.5; no B there, so no reaction.
    expect(ob[1]).toBeCloseTo(0.5 * LAP_EDGE * 0.5, 6);
    expect(ou[1]).toBe(0);
    // Corner: lap(b) = 0.05 * 0.5.
    expect(ob[0]).toBeCloseTo(0.5 * LAP_CORNER * 0.5, 6);
  });
});
