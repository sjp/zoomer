import { describe, expect, it } from "vitest";
import {
  ATTR_MIN_Y,
  attractorAt,
  BIRD_FLOATS,
  birdCounts,
  BOUNDARY_MAX,
  boundaryForce,
  buildHorizon,
  CRUISE,
  EX_Y,
  fieldEncoding,
  gridSize,
  GRID_H,
  HORIZON_COLUMNS,
  HORIZON_MAX,
  MAX_GRID_W,
  PRED_ACCEL,
  PRED_DURATION,
  predatorAt,
  seedBirds,
  SKIES,
  skyFor,
  SPLAT_8BIT_BIRDS,
  SWIRL,
  steeringAt,
  steeringWeights,
} from "./murmuration-sim";
import { MAX_BIRDS } from "./murmuration.meta";

const ASPECTS = [4 / 3, 16 / 9, 21 / 9];

describe("attractorAt", () => {
  it("stays over the upper part of the frame, clear of the sides", () => {
    const out = new Float32Array(2);
    for (const aspect of ASPECTS) {
      let bad = 0;
      for (let t = 0; t < 600; t += 0.25) {
        attractorAt(t, aspect, out);
        if (out[1] < ATTR_MIN_Y - 1e-6 || out[1] > 0.9) bad++;
        if (out[0] < 0.15 * aspect || out[0] > 0.85 * aspect) bad++;
      }
      expect(bad).toBe(0);
    }
    expect(ATTR_MIN_Y).toBeGreaterThan(0.5);
  });

  it("rises over the centre, above the exclusion zone", () => {
    const out = new Float32Array(2);
    let lowest = Infinity;
    for (let t = 0; t < 600; t += 0.1) {
      attractorAt(t, 16 / 9, out);
      if (Math.abs(out[0] / (16 / 9) - 0.5) < 0.05) lowest = Math.min(lowest, out[1]);
    }
    expect(lowest).toBeGreaterThan(0.72);
  });

  it("is continuous", () => {
    const a = new Float32Array(2);
    const b = new Float32Array(2);
    let maxStep = 0;
    for (let t = 0; t < 600; t += 0.05) {
      attractorAt(t, 16 / 9, a);
      attractorAt(t + 0.05, 16 / 9, b);
      maxStep = Math.max(maxStep, Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    // Under 0.1 heights per second: a slow drift.
    expect(maxStep).toBeLessThan(0.005);
  });
});

describe("boundaryForce", () => {
  const f = new Float32Array(2);

  it("is bounded everywhere, on and off the frame", () => {
    for (const aspect of ASPECTS) {
      let max = 0;
      for (let x = -0.3; x <= aspect + 0.3; x += 0.01) {
        for (let y = -0.3; y <= 1.3; y += 0.01) {
          boundaryForce(x, y, aspect, f);
          max = Math.max(max, Math.hypot(f[0], f[1]));
        }
      }
      expect(max).toBeLessThanOrEqual(BOUNDARY_MAX + 1e-6);
      expect(Number.isFinite(max)).toBe(true);
    }
  });

  it("points inwards near every edge", () => {
    const aspect = 16 / 9;
    const problems: string[] = [];
    for (let y = 0.45; y <= 0.95; y += 0.05) {
      if (boundaryForce(0.02, y, aspect, f)[0] <= 0) problems.push(`left ${String(y)}`);
      if (boundaryForce(-0.1, y, aspect, f)[0] <= 0) problems.push(`left outside ${String(y)}`);
      if (boundaryForce(aspect - 0.02, y, aspect, f)[0] >= 0) problems.push(`right ${String(y)}`);
      if (boundaryForce(aspect + 0.1, y, aspect, f)[0] >= 0)
        problems.push(`right outside ${String(y)}`);
    }
    for (let x = 0.1; x < aspect - 0.1; x += 0.05) {
      if (boundaryForce(x, 0.98, aspect, f)[1] >= 0) problems.push(`top ${String(x)}`);
      if (boundaryForce(x, 1.1, aspect, f)[1] >= 0) problems.push(`top outside ${String(x)}`);
      // Everywhere in the bottom third the push is upwards.
      for (let y = -0.1; y < 1 / 3; y += 0.05) {
        if (boundaryForce(x, y, aspect, f)[1] <= 0)
          problems.push(`bottom ${String(x)} ${String(y)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("pushes out of the central exclusion zone, never down", () => {
    const aspect = 16 / 9;
    const cx = aspect / 2;
    const problems: string[] = [];
    for (let x = cx - 0.25; x <= cx + 0.25; x += 0.05) {
      for (let y = 0.35; y <= 0.6; y += 0.05) {
        boundaryForce(x, y, aspect, f);
        const outward = f[0] * (x - cx) + f[1] * (y - EX_Y);
        const deepInside = Math.abs(x - cx) < 0.16 && y < 0.5;
        if (outward < 0 || f[1] < 0 || (deepInside && outward <= 0))
          problems.push(`${String(x)} ${String(y)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("leaves the open sky alone", () => {
    for (const [x, y] of [
      [0.3, 0.7],
      [1.5, 0.6],
      [0.9, 0.85],
    ]) {
      boundaryForce(x, y, 16 / 9, f);
      expect(Math.hypot(f[0], f[1])).toBe(0);
    }
  });
});

describe("steeringWeights", () => {
  it("gives finite, positive weights that grow with cohesion", () => {
    const w = { align: 0, flock: 0, rhoEq: 0, attract: 0 };
    let prev = { align: -1, flock: -1, rhoEq: -1, attract: -1 };
    for (let c = 0; c <= 1; c += 0.1) {
      steeringWeights(c, w);
      for (const k of ["align", "flock", "rhoEq", "attract"] as const) {
        expect(w[k]).toBeGreaterThan(prev[k]);
        expect(w[k]).toBeGreaterThan(0);
      }
      prev = { ...w };
    }
    expect(steeringWeights(1, w)).toEqual({ align: 2.5, flock: 0.014, rhoEq: 16, attract: 0.9 });
  });

  it("clamps out-of-range and non-finite input", () => {
    const w = { align: 0, flock: 0, rhoEq: 0, attract: 0 };
    const hi = { ...steeringWeights(1, w) };
    const lo = { ...steeringWeights(0, w) };
    const mid = { ...steeringWeights(0.5, w) };
    expect(steeringWeights(5, w)).toEqual(hi);
    expect(steeringWeights(-3, w)).toEqual(lo);
    expect(steeringWeights(Number.NaN, w)).toEqual(mid);
  });
});

describe("steeringAt", () => {
  it("keeps both spring rates positive and the swirl bounded", () => {
    const out = new Float32Array(3);
    let bad = 0;
    let minRate = Infinity;
    for (let t = 0; t < 300; t += 0.5) {
      steeringAt(t, 1, out);
      minRate = Math.min(minRate, out[0], out[1]);
      if (Math.abs(out[2]) > SWIRL + 1e-6) bad++;
      if (Math.abs(out[0] + out[1] - 2) > 1e-5) bad++;
    }
    expect(bad).toBe(0);
    expect(minRate).toBeGreaterThan(0.3);
  });
});

describe("predatorAt", () => {
  it("passes every 20-40 s, each for PRED_DURATION, high over the frame", () => {
    const aspect = 16 / 9;
    const out = new Float32Array(3);
    const starts: number[] = [];
    let active = false;
    let bad = 0;
    for (let t = 0; t < 1200; t += 0.05) {
      predatorAt(t, aspect, out);
      const on = out[2] > 0;
      if (on && !active) starts.push(t);
      active = on;
      if (out[2] < 0 || out[2] > PRED_ACCEL) bad++;
      if (on && (out[1] < 0.55 || out[1] > 0.95)) bad++;
      if (on && (out[0] < -0.16 || out[0] > aspect + 0.16)) bad++;
    }
    expect(bad).toBe(0);
    expect(starts.length).toBeGreaterThan(25);
    const gaps = starts.slice(1).map((s, i) => s - starts[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(20 - 0.1);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(40 + 0.1);
    expect(PRED_DURATION).toBeLessThan(20);
  });

  it("crosses the whole frame in one pass", () => {
    const out = new Float32Array(3);
    let t = 0;
    while (predatorAt(t, 16 / 9, out)[2] === 0) t += 0.01;
    const x0 = out[0];
    predatorAt(t + PRED_DURATION - 0.02, 16 / 9, out);
    expect(Math.abs(out[0] - x0)).toBeGreaterThan(16 / 9);
  });

  it("is inactive at negative or non-finite times", () => {
    const out = new Float32Array(3);
    expect(predatorAt(-10, 16 / 9, out)[2]).toBe(0);
    expect(predatorAt(Number.NaN, 16 / 9, out)[2]).toBe(0);
  });
});

describe("birdCounts", () => {
  it("draws fewer birds at lower quality, within the buffers", () => {
    const c = { draw: 0, update: 0 };
    const high = { ...birdCounts(30000, "high", c) };
    const balanced = { ...birdCounts(30000, "balanced", c) };
    const low = { ...birdCounts(30000, "low", c) };
    expect(high).toEqual({ draw: 30000, update: MAX_BIRDS });
    expect(balanced.draw).toBeLessThan(high.draw);
    expect(low.draw).toBeLessThan(balanced.draw);
    expect(low.update).toBeLessThan(high.update);
    for (const x of [high, balanced, low]) {
      expect(x.draw).toBeLessThanOrEqual(x.update);
      expect(x.update).toBeLessThanOrEqual(MAX_BIRDS);
    }
  });

  it("clamps the bird count and falls back for unknown input", () => {
    const c = { draw: 0, update: 0 };
    expect(birdCounts(1e9, "high", c).draw).toBe(MAX_BIRDS);
    expect(birdCounts(-5, "high", c).draw).toBe(0);
    expect(birdCounts(20000, "bogus", c).draw).toBe(20000);
    expect(birdCounts(Number.NaN, "low", c).draw).toBeLessThanOrEqual(c.update);
  });
});

describe("gridSize", () => {
  it("keeps cells square at GRID_H rows", () => {
    expect(gridSize(16 / 9)).toEqual([80, GRID_H]);
    expect(gridSize(4 / 3)).toEqual([60, GRID_H]);
    expect(gridSize(100)).toEqual([MAX_GRID_W, GRID_H]);
    expect(gridSize(0)).toEqual([80, GRID_H]);
    expect(gridSize(Number.NaN)).toEqual([80, GRID_H]);
  });
});

describe("fieldEncoding", () => {
  /** Splats `n` birds with velocity (vx, vy) into one cell, then decodes it. */
  function roundTrip(float: boolean, birds: number, n: number, vx: number, vy: number) {
    const cells = 3600;
    const e = fieldEncoding(float, birds, cells, {
      stride: 0,
      deposit: 0,
      rhoScale: 0,
      quantise: 0,
    });
    let r = 0;
    let g = 0;
    let b = 0;
    let splatted = 0;
    for (let i = 0; i < n * e.stride; i++) {
      if (i % e.stride !== 0) continue;
      splatted++;
      // Quantised: floor(1 + v + u) with u uniform, evenly spread here.
      const u = (splatted % 16) / 16 + 1 / 32;
      const ex = e.quantise ? Math.floor(1 + vx + u) * 0.5 : 0.5 + 0.5 * vx;
      const ey = e.quantise ? Math.floor(1 + vy + u) * 0.5 : 0.5 + 0.5 * vy;
      r += ex * e.deposit;
      g += ey * e.deposit;
      b += e.deposit;
    }
    return {
      e,
      b,
      rho: b * e.rhoScale,
      expected: (n * e.stride * cells) / birds,
      vx: (2 * r) / b - 1,
      vy: (2 * g) / b - 1,
    };
  }

  it("decodes density and mean velocity on half floats", () => {
    const x = roundTrip(true, 24000, 50, 0.3, -0.6);
    expect(x.e.stride).toBe(1);
    expect(x.rho).toBeCloseTo(x.expected, 6);
    expect(x.vx).toBeCloseTo(0.3, 6);
    expect(x.vy).toBeCloseTo(-0.6, 6);
  });

  it("decodes on the RGBA8 fallback within its rounding, without saturating", () => {
    for (const birds of [10000, 24000, MAX_BIRDS]) {
      const x = roundTrip(false, birds, 60, 0.3, -0.6);
      expect(Math.ceil(birds / x.e.stride)).toBeLessThanOrEqual(SPLAT_8BIT_BIRDS);
      expect(x.rho / x.expected).toBeCloseTo(1, 1);
      expect(Math.abs(x.vx - 0.3)).toBeLessThan(0.05);
      expect(Math.abs(x.vy + 0.6)).toBeLessThan(0.05);
      // 60 splatted birds in one cell still fit an 8-bit channel.
      expect(x.b).toBeLessThanOrEqual(1);
    }
  });
});

describe("seedBirds", () => {
  it("starts a cruising flock in the upper frame, deterministically", () => {
    const n = 2000;
    const a = seedBirds(3, n, 16 / 9, new Float32Array(n * BIRD_FLOATS));
    const b = seedBirds(3, n, 16 / 9, new Float32Array(n * BIRD_FLOATS));
    expect(a).toEqual(b);
    let bad = 0;
    for (let i = 0; i < n; i++) {
      const o = i * BIRD_FLOATS;
      if (a[o] < 0 || a[o] > 16 / 9 || a[o + 1] < 0.4 || a[o + 1] > 1) bad++;
      if (Math.abs(Math.hypot(a[o + 2], a[o + 3]) - CRUISE) > 1e-6) bad++;
    }
    expect(bad).toBe(0);
  });
});

describe("buildHorizon", () => {
  it("is empty for none and unknown kinds", () => {
    const out = new Float32Array(HORIZON_COLUMNS).fill(1);
    expect(buildHorizon("none", 16 / 9, out).every((h) => h === 0)).toBe(true);
    expect(buildHorizon("bogus", 16 / 9, out).every((h) => h === 0)).toBe(true);
  });

  it("builds low, bounded, deterministic silhouettes", () => {
    for (const kind of ["reeds", "trees"]) {
      const a = buildHorizon(kind, 16 / 9, new Float32Array(HORIZON_COLUMNS));
      const b = buildHorizon(kind, 16 / 9, new Float32Array(HORIZON_COLUMNS));
      expect(a).toEqual(b);
      let min = Infinity;
      let max = -Infinity;
      for (const h of a) {
        min = Math.min(min, h);
        max = Math.max(max, h);
      }
      expect(min).toBeGreaterThan(0.015);
      expect(max).toBeLessThanOrEqual(HORIZON_MAX);
      expect(max).toBeGreaterThan(0.06);
    }
  });
});

describe("skyFor", () => {
  it("falls back to dusk", () => {
    expect(skyFor("overcast")).toBe(SKIES.overcast);
    expect(skyFor("bogus")).toBe(SKIES.dusk);
  });
});
