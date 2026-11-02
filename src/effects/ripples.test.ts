import { describe, expect, it } from "vitest";
import { createRng } from "./noise";
import { waterFragment } from "./ripples";
import {
  addDrop,
  BRANCH_H,
  BRANCH_W,
  buildBranchMask,
  createDropBuffer,
  createRainState,
  DROP_STRIDE,
  MAX_DROPS,
  MAX_LIFE,
  MIN_LIFE,
  packDrops,
  rateAt,
  ringAmplitude,
  ringHeight,
  ringSlope,
  rippleGradient,
  rippleHeight,
  stepRain,
  targetLife,
} from "./ripples-sim";

describe("drop ring buffer", () => {
  it("keeps at most the cap and recycles the oldest drop", () => {
    const b = createDropBuffer(4);
    for (let i = 0; i < 4; i++) addDrop(b, i / 10, 0, 1, i, 0);
    expect(b.count).toBe(4);
    expect(b.head).toBe(0);
    // The fifth drop replaces the first (oldest), the sixth the second.
    expect(addDrop(b, 0.9, 0, 1, 4, 0)).toBe(0);
    expect(addDrop(b, 0.8, 0, 1, 5, 0)).toBe(1);
    expect(b.count).toBe(4);
    expect(Array.from(b.birth)).toEqual([4, 5, 2, 3]);
  });
});

describe("rain", () => {
  const countOver = (seconds: number, rate: number, variation: number) => {
    const rng = createRng(11);
    const s = createRainState(rng);
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) stepRain(s, dt, rate, variation, 55, rng);
    return s;
  };

  it("spawns at `rate` on average", () => {
    expect(countOver(2000, 3, 0).spawned / 2000).toBeCloseTo(3, 1);
    // The variation has zero mean, so it barely moves the long-run rate.
    expect(Math.abs(countOver(3000, 3, 1).spawned / 3000 - 3)).toBeLessThan(0.2);
  });

  it("varies the rate slowly, within the swing", () => {
    let lo = Infinity;
    let hi = -Infinity;
    let maxStep = 0;
    for (let t = 0; t < 200; t += 0.1) {
      const r = rateAt(4, 1, t);
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
      maxStep = Math.max(maxStep, Math.abs(rateAt(4, 1, t + 0.1) - r));
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi / Math.max(lo, 1e-9)).toBeGreaterThan(3);
    expect(maxStep).toBeLessThan(0.1);
    expect(rateAt(4, 0, 12.3)).toBe(4);
  });

  it("keeps the buffer capped and shortens rings in a heavy shower", () => {
    const s = countOver(60, 10, 1);
    expect(s.drops.count).toBe(MAX_DROPS);
    expect(s.life).toBeGreaterThanOrEqual(MIN_LIFE);
    expect(s.life).toBeLessThan(MAX_LIFE);
    expect(targetLife(0)).toBe(MAX_LIFE);
    expect(targetLife(1000)).toBe(MIN_LIFE);
  });

  it("does nothing for a zero or invalid step", () => {
    const rng = createRng(1);
    const s = createRainState(rng);
    stepRain(s, 0, 5, 0, 55, rng);
    stepRain(s, Number.NaN, 5, 0, 55, rng);
    expect(s.time).toBe(0);
    expect(s.spawned).toBe(0);
  });
});

describe("ring profile", () => {
  const rho = 50;
  const w = 25;
  const k = (2 * Math.PI) / 20;

  it("has compact support", () => {
    for (const r of [0, rho - w - 5, rho - w, rho + w, rho + w + 0.01, 500]) {
      expect(ringHeight(r, rho, w, k)).toBe(0);
      expect(ringSlope(r, rho, w, k)).toBe(0);
    }
    expect(Math.abs(ringHeight(rho, rho, w, k))).toBeGreaterThan(0.5);
  });

  it("is continuous, with a continuous slope, at the envelope edge", () => {
    for (const edge of [rho - w, rho + w]) {
      for (const e of [1e-3, 1e-4]) {
        expect(Math.abs(ringHeight(edge - e, rho, w, k))).toBeLessThan(e * 0.1);
        expect(Math.abs(ringHeight(edge + e, rho, w, k))).toBeLessThan(e * 0.1);
        expect(Math.abs(ringSlope(edge - e, rho, w, k))).toBeLessThan(e * 2);
        expect(Math.abs(ringSlope(edge + e, rho, w, k))).toBeLessThan(e * 2);
      }
    }
  });

  it("slope matches a finite difference of the height", () => {
    const e = 1e-4;
    for (let r = rho - w + 0.3; r < rho + w; r += 1.7) {
      const fd = (ringHeight(r + e, rho, w, k) - ringHeight(r - e, rho, w, k)) / (2 * e) / k;
      expect(ringSlope(r, rho, w, k)).toBeCloseTo(fd, 5);
    }
  });

  it("fades in, then out to exactly zero at the end of life", () => {
    expect(ringAmplitude(0, 4)).toBe(0);
    expect(ringAmplitude(4, 4)).toBe(0);
    expect(ringAmplitude(5, 4)).toBe(0);
    expect(ringAmplitude(0.2, 4)).toBeCloseTo(0.95 ** 2, 6);
    expect(ringAmplitude(1, 4)).toBeGreaterThan(ringAmplitude(3, 4));
  });
});

describe("packed rings", () => {
  const rng = createRng(5);
  const s = createRainState(rng);
  for (let i = 0; i < 300; i++) stepRain(s, 1 / 60, 8, 0, 55, rng);
  const packed = new Float32Array(MAX_DROPS * DROP_STRIDE);
  const n = packDrops(packed, s, 400, 225, 400 / 1920, 20);

  it("packs only live rings, inside the target", () => {
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThanOrEqual(s.drops.count);
    for (let i = 0; i < n; i++) {
      const o = i * DROP_STRIDE;
      expect(packed[o]).toBeGreaterThanOrEqual(0);
      expect(packed[o]).toBeLessThanOrEqual(400);
      expect(packed[o + 1]).toBeLessThanOrEqual(225);
      // Outer radius = rho + halfWidth.
      expect(Math.sqrt(packed[o + 2])).toBeCloseTo(packed[o + 4] + 1 / packed[o + 5], 3);
      expect(packed[o + 7]).toBeGreaterThan(0);
    }
  });

  it("gradient matches a finite difference of the height", () => {
    const g = new Float64Array(2);
    const e = 1e-3;
    let checked = 0;
    for (let i = 0; i < n; i++) {
      const o = i * DROP_STRIDE;
      // Sample points on each packet, where the gradient is non-zero.
      for (let a = 0; a < 6; a++) {
        const r = packed[o + 4] + (a / 6 - 0.4) / packed[o + 5];
        const px = packed[o] + r * Math.cos(a * 1.1);
        const py = packed[o + 1] + r * Math.sin(a * 1.1);
        rippleGradient(packed, n, px, py, g);
        const fx =
          (rippleHeight(packed, n, px + e, py) - rippleHeight(packed, n, px - e, py)) / (2 * e);
        const fy =
          (rippleHeight(packed, n, px, py + e) - rippleHeight(packed, n, px, py - e)) / (2 * e);
        expect(g[0]).toBeCloseTo(fx, 3);
        expect(g[1]).toBeCloseTo(fy, 3);
        if (Math.hypot(g[0], g[1]) > 1e-3) checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe("branch mask", () => {
  const m = buildBranchMask();

  it("covers the top corners and leaves the middle clear", () => {
    expect(m.length).toBe(BRANCH_W * BRANCH_H);
    const at = (u: number, v: number) =>
      m[Math.floor(v * (BRANCH_H - 1)) * BRANCH_W + Math.floor(u * (BRANCH_W - 1))];
    expect(at(0.01, 0.99)).toBe(255);
    expect(at(0.5, 0.5)).toBe(0);
    expect(at(0.5, 0.05)).toBe(0);
    let covered = 0;
    for (const v of m) covered += v / 255;
    expect(covered / m.length).toBeGreaterThan(0.03);
    expect(covered / m.length).toBeLessThan(0.3);
  });
});

describe("shader", () => {
  it("fetches the branch mask only when branches are on", () => {
    const count = (s: string) => s.match(/texture\(/g)?.length ?? 0;
    expect(count(waterFragment(true))).toBe(1);
    expect(count(waterFragment(false))).toBe(0);
    expect(waterFragment(false)).toContain(`uniform vec4 uDrops[${MAX_DROPS * 2}];`);
  });
});
