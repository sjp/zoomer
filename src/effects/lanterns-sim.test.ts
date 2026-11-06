import { describe, expect, it } from "vitest";
import {
  BODY_STRIP,
  createLanterns,
  FLICKER_DEPTH,
  FLICKER_MAX_HZ,
  flicker,
  HALO_MIN_DEPTH,
  LANTERN_FLOATS,
  type LanternFrame,
  lanternOutline,
  lanternReach,
  reflectY,
} from "./lanterns-sim";

const MAX = 150;
const frame = (over: Partial<LanternFrame> = {}): LanternFrame => ({
  refWidth: 1920,
  scale: 1,
  count: MAX,
  size: 64,
  rise: 1,
  wind: 0.2,
  flicker: 0.5,
  bottom: 1080,
  lanternColor: [1, 0.63, 0.25],
  skyTop: [0.04, 0.05, 0.15],
  skyBottom: [0.29, 0.14, 0.25],
  ...over,
});

const isSorted = (a: ArrayLike<number>) => {
  for (let i = 1; i < a.length; i++) {
    if (a[i] < a[i - 1]) {
      return false;
    }
  }
  return true;
};

describe("lantern shape", () => {
  it("is wider at the top than the bottom and fits its half-height", () => {
    const o = lanternOutline();
    let topW = 0;
    let botW = 0;
    for (let i = 0; i < o.length; i += 2) {
      const [x, y] = [o[i], o[i + 1]];
      expect(Math.abs(y)).toBeLessThanOrEqual(1.3 + 1e-9);
      if (y < -1) {
        topW = Math.max(topW, Math.abs(x));
      }
      if (y > 1) {
        botW = Math.max(botW, Math.abs(x));
      }
    }
    expect(topW).toBeGreaterThan(botW);
  });

  it("is a fan strip with the centre the only corner at the origin", () => {
    const n = lanternOutline().length / 2;
    expect(BODY_STRIP.length / 2).toBe(2 * n + 1);
    for (let i = 0; i < BODY_STRIP.length; i += 2) {
      const atOrigin = BODY_STRIP[i] === 0 && BODY_STRIP[i + 1] === 0;
      expect(atOrigin).toBe((i / 2) % 2 === 1);
    }
  });
});

describe("flicker", () => {
  it("is bounded by the flicker depth", () => {
    for (const amount of [0, 0.5, 1, 2]) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let t = 0; t < 60; t += 0.037) {
        const v = flicker(t, 1.3, 0.7, amount);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      expect(hi).toBeLessThanOrEqual(1);
      expect(lo).toBeGreaterThanOrEqual(1 - Math.min(1, amount) * FLICKER_DEPTH - 1e-12);
    }
    expect(flicker(12.3, 2, 0.4, 0)).toBe(1);
  });

  it("is continuous and changes no faster than its frequency cap allows", () => {
    expect(FLICKER_MAX_HZ).toBeLessThan(2);
    // |d/dt| of the curve is at most the depth times the fastest angular rate.
    const maxSlope = FLICKER_DEPTH * 2 * Math.PI * FLICKER_MAX_HZ;
    const h = 1e-3;
    let steepest = 0;
    for (const rate of [0, 0.5, 1]) {
      for (let t = 0; t < 30; t += 0.05) {
        const slope = Math.abs(flicker(t + h, 0.4, rate, 1) - flicker(t, 0.4, rate, 1)) / h;
        steepest = Math.max(steepest, slope);
      }
    }
    expect(steepest).toBeLessThanOrEqual(maxSlope);
  });
});

describe("reflectY", () => {
  it("maps the horizon onto itself and is its own inverse", () => {
    expect(reflectY(820, 820)).toBe(820);
    expect(reflectY(reflectY(300, 820), 820)).toBe(300);
    expect(reflectY(700, 820)).toBe(940);
  });
});

describe("createLanterns", () => {
  it("creates depths sorted far to near", () => {
    const l = createLanterns(MAX, 1920);
    expect(isSorted(l.depth)).toBe(true);
    expect(l.depth[0]).toBeGreaterThanOrEqual(0);
    expect(l.depth[MAX - 1]).toBeLessThanOrEqual(1);
  });

  it("keeps positions in bounds and depths unchanged while rising, swaying and respawning", () => {
    const l = createLanterns(MAX, 1920);
    const depths = Float32Array.from(l.depth);
    const data = new Float32Array(MAX * LANTERN_FLOATS);
    const out: string[] = [];
    for (const f of [frame(), frame({ wind: -1, rise: 3 }), frame({ bottom: 820, wind: 1 })]) {
      for (let s = 0; s < 400; s++) {
        l.step(0.25, f, data, LANTERN_FLOATS);
        for (let i = 0; i < MAX; i++) {
          const reach = lanternReach(l.depth[i], f.size);
          // Below the bottom line only while a lowered horizon is still rising past it.
          const ok =
            l.x[i] >= -reach &&
            l.x[i] < f.refWidth + reach &&
            l.y[i] >= -reach &&
            l.y[i] <= 1080 + reach;
          if (!ok) {
            out.push(`${String(i)}: ${String(l.x[i])}, ${String(l.y[i])}`);
          }
        }
      }
    }
    expect(out).toEqual([]);
    expect(l.depth).toEqual(depths);
    expect(isSorted(l.depth)).toBe(true);
  });

  it("respawns lanterns below the bottom line once they leave the top", () => {
    const l = createLanterns(MAX, 1920);
    const data = new Float32Array(MAX * LANTERN_FLOATS);
    const f = frame({ bottom: 820, rise: 2 });
    const respawnedAt: number[] = [];
    for (let s = 0; s < 600; s++) {
      const before = Float64Array.from(l.y);
      l.step(0.1, f, data, LANTERN_FLOATS);
      for (let i = 0; i < MAX; i++) {
        if (l.y[i] > before[i]) {
          respawnedAt.push(l.y[i]);
        }
      }
    }
    expect(respawnedAt.length).toBeGreaterThan(0);
    expect(Math.min(...respawnedAt)).toBeGreaterThan(820);
  });

  it("writes visible lanterns far to near, halos only from haloFirst on", () => {
    const l = createLanterns(MAX, 1920);
    const data = new Float32Array(MAX * LANTERN_FLOATS);
    // Fade everyone in.
    for (let s = 0; s < 20; s++) {
      l.step(0.1, frame(), data, LANTERN_FLOATS);
    }
    const n = l.step(0.1, frame(), data, LANTERN_FLOATS);
    expect(n).toBe(MAX);
    const radii: number[] = [];
    for (let i = 0; i < n; i++) {
      const o = i * LANTERN_FLOATS;
      radii.push(data[o + 2]);
      expect(data[o + 7] > 0).toBe(i >= l.haloFirst);
      for (let c = 4; c < 7; c++) {
        expect(data[o + c]).toBeGreaterThanOrEqual(0);
        expect(data[o + c]).toBeLessThanOrEqual(1);
      }
    }
    expect(isSorted(radii)).toBe(true);
    expect(l.haloFirst).toBe(l.depth.filter((d) => d < HALO_MIN_DEPTH).length);
  });

  it("shows a count spread over depths, fading the rest out", () => {
    const l = createLanterns(MAX, 1920);
    const data = new Float32Array(MAX * LANTERN_FLOATS);
    let n = 0;
    for (let s = 0; s < 40; s++) {
      n = l.step(0.1, frame({ count: 30 }), data, LANTERN_FLOATS);
    }
    expect(n).toBe(30);
    // Not just the 30 farthest: some near ones are included.
    let maxR = 0;
    for (let i = 0; i < n; i++) {
      maxR = Math.max(maxR, data[i * LANTERN_FLOATS + 2]);
    }
    expect(maxR).toBeGreaterThan(64 / 2.6 / 2);
  });
});
