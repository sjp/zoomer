import { describe, expect, it } from "vitest";
import {
  APPROACH_DIST,
  biolumFront,
  biolumWetness,
  BREAK,
  capGlow,
  createBiolumScheduler,
  foamWidth,
  GLOW_END,
  glowEnergy,
  HORIZON,
  LIFETIME,
  MAX_WAVES,
  packWaves,
  PEEL_MAX,
  REACH_MAX,
  shoreLine,
  shoreNormal,
  SPACING_MIN,
  WAVE_FLOATS,
  WET_TAIL,
} from "./biolum-sim";
import { MAX_INTERVAL, MIN_INTERVAL, SHORELINE_OPTIONS } from "./biolum.meta";
import { T_ACTIVE, T_APPROACH, T_STOP } from "../wash";

describe("glowEnergy", () => {
  it("is continuous, bounded and returns to zero", () => {
    let prev = glowEnergy(-1);
    let peak = 0;
    const bad: string[] = [];
    for (let t = -1; t < LIFETIME + 2; t += 0.001) {
      const e = glowEnergy(t);
      if (!(e >= 0 && e <= 1 && Math.abs(e - prev) < 0.01) && bad.length < 10) {
        bad.push(`t ${String(t)}: ${String(prev)} -> ${String(e)}`);
      }
      peak = Math.max(peak, e);
      prev = e;
    }
    expect(bad).toEqual([]);
    expect(peak).toBeGreaterThan(0.9);
    expect(glowEnergy(GLOW_END)).toBe(0);
    expect(glowEnergy(LIFETIME)).toBe(0);
  });

  it("is dark on the approach and peaks just after the break", () => {
    expect(glowEnergy(0)).toBe(0);
    expect(glowEnergy(T_APPROACH - 1)).toBe(0);
    expect(glowEnergy(T_APPROACH + 0.4)).toBeGreaterThan(0.9);
    // Lingers through the run-up, then fades as it drains.
    expect(glowEnergy(T_STOP)).toBeGreaterThan(0.6);
    expect(glowEnergy(T_STOP + 2)).toBeLessThan(0.2);
  });
});

describe("foamWidth", () => {
  it("grows as the foam spreads", () => {
    expect(foamWidth(T_ACTIVE)).toBeGreaterThan(foamWidth(T_APPROACH));
    expect(foamWidth(0)).toBeGreaterThan(0);
  });
});

describe("biolumFront", () => {
  it("rolls in from the approach distance and drains back to the shoreline", () => {
    expect(biolumFront(0, 0.15)).toBeCloseTo(-APPROACH_DIST);
    expect(biolumFront(T_APPROACH, 0.15)).toBeCloseTo(-BREAK);
    expect(biolumFront(T_STOP, 0.15)).toBeCloseTo(0.15);
    expect(biolumFront(T_ACTIVE, 0.15)).toBe(0);
  });
});

describe("biolumWetness", () => {
  it("is bounded, wets only covered sand and is gone by the end of the tail", () => {
    for (let t = 0; t < LIFETIME; t += 0.05) {
      for (let n = -0.1; n < 0.25; n += 0.01) {
        const w = biolumWetness(n, t, 0.15);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
        expect(n > 0.15 + 1e-9 && w !== 0).toBe(false);
      }
    }
    expect(biolumWetness(0.1, T_STOP, 0.15)).toBeCloseTo(1);
    expect(biolumWetness(0.05, T_ACTIVE + WET_TAIL, 0.15)).toBe(0);
  });
});

describe("capGlow", () => {
  it("is monotonic, starts at zero and never reaches one", () => {
    expect(capGlow(0)).toBe(0);
    expect(capGlow(-1)).toBe(0);
    let prev = 0;
    for (let g = 0.1; g <= 3; g += 0.1) {
      const v = capGlow(g);
      expect(v).toBeGreaterThan(prev);
      expect(v).toBeLessThan(1);
      prev = v;
    }
  });
});

describe("createBiolumScheduler", () => {
  const run = (seed: number, interval: number, seconds: number, dt = 1 / 60) => {
    const s = createBiolumScheduler(seed);
    const starts: number[] = [];
    let maxCount = 0;
    for (let t = 0; t < seconds; t += dt) {
      const before = s.spawned;
      s.step(dt, interval);
      if (s.spawned > before) {
        starts.push(s.waves[s.count - 1].start);
      }
      maxCount = Math.max(maxCount, s.count);
    }
    return { s, starts, maxCount };
  };

  it("spawns at the configured average interval", () => {
    for (const interval of [MIN_INTERVAL, 8, MAX_INTERVAL]) {
      const { starts } = run(3, interval, 3000);
      const mean = (starts[starts.length - 1] - starts[0]) / (starts.length - 1);
      expect(mean).toBeGreaterThan(interval * 0.95);
      expect(mean).toBeLessThan(interval * 1.05);
      for (let i = 1; i < starts.length; i++) {
        // A new wave never waits for a slot: gaps stay within the spacing range (plus a frame).
        expect(starts[i] - starts[i - 1]).toBeLessThan(interval * 1.1 + 0.05);
        expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(interval * 0.9 - 1e-9);
      }
    }
  });

  it("caps the number of active waves", () => {
    expect(LIFETIME).toBeLessThan(MAX_WAVES * MIN_INTERVAL * SPACING_MIN);
    const { maxCount } = run(5, MIN_INTERVAL, 600);
    expect(maxCount).toBeLessThanOrEqual(MAX_WAVES);
    expect(maxCount).toBeGreaterThanOrEqual(2);
    // Out-of-range intervals are clamped.
    expect(run(5, 0.1, 200).maxCount).toBeLessThanOrEqual(MAX_WAVES);
  });

  it("is deterministic per seed", () => {
    const a = run(11, 8, 200);
    const b = run(11, 8, 200);
    const c = run(12, 8, 200);
    expect(a.starts).toEqual(b.starts);
    expect(a.s.waves.map((w) => w.reach)).toEqual(b.s.waves.map((w) => w.reach));
    expect(a.starts).not.toEqual(c.starts);
  });

  it("reset restarts the same sequence for the same seed", () => {
    const s = createBiolumScheduler(4);
    s.step(30, 8);
    s.reset(9);
    expect(s.count).toBe(0);
    expect(s.time).toBe(0);
    const fresh = createBiolumScheduler(9);
    for (let i = 0; i < 2000; i++) {
      s.step(0.05, 8);
      fresh.step(0.05, 8);
    }
    expect(s.count).toBe(fresh.count);
    expect(s.waves.slice(0, s.count).map((w) => w.start)).toEqual(
      fresh.waves.slice(0, fresh.count).map((w) => w.start),
    );
  });

  it("gives waves bounded reach and both peel directions", () => {
    const s = createBiolumScheduler(1);
    const dirs = new Set<number>();
    // Plain comparisons in the hot loop: an expect per wave costs far more than the check.
    const bad: string[] = [];
    for (let i = 0; i < 20000; i++) {
      s.step(0.05, 6);
      for (let k = 0; k < s.count; k++) {
        const { reach, peelSpan } = s.waves[k];
        if (!(reach < REACH_MAX && peelSpan <= PEEL_MAX) && bad.length < 10) {
          bad.push(
            `step ${String(i)}, wave ${String(k)}: reach ${String(reach)}, peelSpan ${String(peelSpan)}`,
          );
        }
        dirs.add(s.waves[k].peelDir);
      }
    }
    expect(bad).toEqual([]);
    expect([...dirs].toSorted((a, b) => a - b)).toEqual([-1, 1]);
  });
});

describe("packWaves", () => {
  it("packs each wave's local clock so the break sweeps across the frame", () => {
    const s = createBiolumScheduler(2);
    s.step(0, 8);
    s.step(5, 8);
    const out = new Float32Array(MAX_WAVES * WAVE_FLOATS);
    const aspect = 16 / 9;
    expect(packWaves(s, aspect, out)).toBe(s.count);
    const w = s.waves[0];
    const tau = s.time - w.start;
    const at = (x: number) => out[0] - out[1] * x;
    const first = w.peelDir > 0 ? 0 : aspect;
    const last = aspect - first;
    expect(at(first)).toBeCloseTo(tau, 5);
    expect(at(last)).toBeCloseTo(tau - w.peelSpan, 5);
    expect(out[2]).toBeCloseTo(w.reach, 6);
    expect(out[4]).toBeCloseTo(w.offX, 6);
  });
});

describe("shoreLine", () => {
  it("keeps every layout's shoreline in the lower part of the frame", () => {
    const out = new Float32Array(2);
    for (const { value } of SHORELINE_OPTIONS) {
      for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
        shoreLine(value, aspect, out);
        for (const x of [0, aspect / 2, aspect]) {
          const y = out[0] + out[1] * x;
          expect(y).toBeGreaterThan(0.08);
          expect(y).toBeLessThan(HORIZON - 0.15);
        }
      }
    }
  });

  it("rises toward the named side", () => {
    const out = new Float32Array(2);
    expect(shoreLine("diagonal-left", 2, out)[1]).toBeLessThan(0);
    expect(shoreLine("diagonal-right", 2, out)[1]).toBeGreaterThan(0);
    expect(shoreLine("nope", 2, out)[1]).toBe(0);
  });
});

describe("shoreNormal", () => {
  it("is zero on the shoreline, positive landward and grows toward the horizon seaward", () => {
    const [c, k] = [0.3, 0.05];
    const x = 0.8;
    const ys = c + k * x;
    expect(shoreNormal(x, ys, c, k)).toBeCloseTo(0, 9);
    expect(shoreNormal(x, ys - 0.1, c, k)).toBeGreaterThan(0);
    expect(shoreNormal(x, ys + 0.1, c, k)).toBeLessThan(0);
    expect(shoreNormal(x, HORIZON - 0.001, c, k)).toBeLessThan(-APPROACH_DIST);
  });
});
