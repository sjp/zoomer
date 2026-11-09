import { describe, expect, it } from "vitest";
import {
  coverageThreshold,
  createRegionLayout,
  FRAME_DEPTH,
  frameMask,
  GUST_MAX,
  gustLevel,
  LAYER_COUNT,
  LAYERS,
  layoutRegion,
  MID_WEIGHT,
  NEAR_WEIGHT,
  NOISE_PERIOD,
  NOISE_SEEDS,
  NOISE_SIZE,
  REGION_SOFT,
  regionMask,
  softnessWidth,
  sunBasis,
  swayBound,
  swayOffset,
  advanceLayerDrift,
  layerOffset,
  DRIFT_SPEED,
} from "./dapple-sim";
import { smoothstep } from "../math";
import { buildPeriodicNoiseTexture, createNoise } from "../noise";
import { POSITION_OPTIONS } from "./dapple.meta";

const noise = createNoise(35);

describe("swayOffset", () => {
  it("stays within its bound on both axes", () => {
    const out = new Float64Array(2);
    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      for (const gust of [1, 1 + GUST_MAX]) {
        const bound = swayBound(layer, gust);
        for (let t = 0; t < 600; t += 0.37) {
          swayOffset(out, noise, layer, t, 1, gust);
          expect(Math.abs(out[0])).toBeLessThanOrEqual(bound);
          expect(Math.abs(out[1])).toBeLessThanOrEqual(bound);
        }
      }
    }
  });

  it("is continuous: a frame step moves it by well under a pixel", () => {
    const a = new Float64Array(2);
    const b = new Float64Array(2);
    const dt = 1 / 120;
    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      // Includes a long-running time, where only the phase is wrapped.
      for (const t0 of [0, 123.4, 86400 * 3]) {
        for (let t = t0; t < t0 + 30; t += 0.1) {
          swayOffset(a, noise, layer, t, 1, 1 + GUST_MAX);
          swayOffset(b, noise, layer, t + dt, 1, 1 + GUST_MAX);
          expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThan(0.3);
        }
      }
    }
  });

  it("is still at sway 0 and actually sways at sway 1", () => {
    const out = new Float64Array(2);
    swayOffset(out, noise, 0, 12.3, 0, 2);
    expect(Math.abs(out[0])).toBe(0);
    expect(Math.abs(out[1])).toBe(0);
    let peak = 0;
    for (let t = 0; t < LAYERS[0].period; t += 0.05) {
      swayOffset(out, noise, 0, t, 1, 1);
      peak = Math.max(peak, Math.abs(out[0]));
    }
    expect(peak).toBeGreaterThan(LAYERS[0].amp * 0.8);
  });

  it("keeps every layer to a few pixels with a slow period", () => {
    for (const l of LAYERS) {
      expect(l.amp).toBeLessThanOrEqual(8);
      expect(l.period).toBeGreaterThanOrEqual(3);
      expect(l.period).toBeLessThanOrEqual(8);
    }
  });
});

describe("gustLevel", () => {
  it("is exactly 1 with gusts off", () => {
    for (let t = 0; t < 200; t += 7.1) {
      expect(gustLevel(noise, t, 0)).toBe(1);
    }
  });

  it("stays in [1, 1 + GUST_MAX * gusts] and reaches gusts now and then", () => {
    for (const g of [0.3, 1]) {
      let hi = 0;
      for (let t = 0; t < 2000; t += 0.5) {
        const v = gustLevel(noise, t, g);
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(1 + GUST_MAX * g + 1e-12);
        hi = Math.max(hi, v);
      }
      expect(hi).toBeGreaterThan(1 + 0.5 * GUST_MAX * g);
    }
  });

  it("changes slowly", () => {
    for (let t = 0; t < 1000; t += 0.25) {
      expect(Math.abs(gustLevel(noise, t + 0.25, 1) - gustLevel(noise, t, 1))).toBeLessThan(0.1);
    }
  });
});

describe("coverageThreshold", () => {
  it("is non-increasing in coverage and spans nothing lit to all lit", () => {
    for (const softness of [0, 0.5, 1]) {
      const s = softnessWidth(softness);
      expect(coverageThreshold(0, s)).toBe(1 + s);
      expect(coverageThreshold(1, s)).toBe(-s);
      expect(coverageThreshold(-1, s)).toBe(1 + s);
      expect(coverageThreshold(2, s)).toBe(-s);
      let prev = Infinity;
      for (let c = 0; c <= 1.0000001; c += 0.01) {
        const t = coverageThreshold(c, s);
        expect(t).toBeLessThanOrEqual(prev);
        prev = t;
      }
      expect(coverageThreshold(0.5, s)).toBeCloseTo(0.5, 10);
    }
  });

  it("matches the lit fraction of the real summed noise", () => {
    const data = buildPeriodicNoiseTexture(
      NOISE_SIZE,
      NOISE_SEEDS.map((seed) => ({ period: NOISE_PERIOD, seed })),
    );
    const n = NOISE_SIZE * NOISE_SIZE;
    const s = softnessWidth(0.5);
    for (const c of [0.1, 0.25, 0.5, 0.75]) {
      const t = coverageThreshold(c, s);
      let lit = 0;
      for (let i = 0; i < n; i++) {
        // Pair the mid channel with a shifted texel, as the layers' scales and offsets differ.
        const j = (i * 7 + 999) % n;
        const v = (NEAR_WEIGHT * data[i * 4] + MID_WEIGHT * data[j * 4 + 1]) / 255;
        lit += smoothstep(t - s, t + s, v);
      }
      expect(lit / n).toBeCloseTo(c, 1);
    }
  });
});

describe("sunBasis", () => {
  it("squeezes distances along the sun direction only", () => {
    const m = new Float64Array(4);
    for (const deg of [-45, 0, 20, 45]) {
      sunBasis(m, deg);
      const a = (deg * Math.PI) / 180;
      const apply = (x: number, y: number) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
      const [ax, ay] = apply(Math.sin(a), Math.cos(a));
      const [bx, by] = apply(Math.cos(a), -Math.sin(a));
      expect(Math.hypot(ax, ay)).toBeLessThan(0.8);
      expect(Math.hypot(bx, by)).toBeCloseTo(1, 10);
    }
  });
});

describe("regionMask", () => {
  const W = 1920;
  const layout = (pos: string) => layoutRegion(createRegionLayout(), pos, W);

  it("is 1 inside, 0 far outside, for every preset", () => {
    const inside: Record<string, [number, number][]> = {
      topRight: [
        [W - 20, 20],
        [W / 2, 20],
        [W - 20, 1060],
      ],
      topLeft: [
        [20, 20],
        [W / 2, 20],
        [20, 1060],
      ],
      right: [
        [W - 20, 20],
        [W - 20, 1060],
      ],
      left: [
        [20, 20],
        [20, 1060],
      ],
      full: [
        [20, 20],
        [W / 2, 540],
        [W - 20, 1060],
      ],
    };
    const outside: Record<string, [number, number][]> = {
      topRight: [
        [W / 2, 800],
        [20, 1060],
      ],
      topLeft: [
        [W / 2, 800],
        [W - 20, 1060],
      ],
      right: [
        [W / 2, 20],
        [20, 540],
      ],
      left: [
        [W / 2, 20],
        [W - 20, 540],
      ],
      full: [],
    };
    for (const { value } of POSITION_OPTIONS) {
      const r = layout(value);
      for (const [x, y] of inside[value]) {
        expect(regionMask(x, y, r)).toBe(1);
      }
      for (const [x, y] of outside[value]) {
        expect(regionMask(x, y, r)).toBe(0);
      }
    }
  });

  it("keeps the speaker's area in plain shade except for Full", () => {
    for (const { value } of POSITION_OPTIONS) {
      if (value === "full") {
        continue;
      }
      expect(regionMask(W / 2, 640, layout(value))).toBe(0);
    }
  });

  it("is smooth: no jumps along lines through the frame", () => {
    for (const { value } of POSITION_OPTIONS) {
      const r = layout(value);
      const maxStep = (1.5 / (2 * REGION_SOFT)) * 2;
      for (let x = 0; x < W; x += 2) {
        for (const y of [100, 540, 900]) {
          expect(Math.abs(regionMask(x + 2, y, r) - regionMask(x, y, r))).toBeLessThan(maxStep);
        }
      }
      for (let y = 0; y < 1080; y += 2) {
        for (const x of [100, W / 2, W - 100]) {
          expect(Math.abs(regionMask(x, y + 2, r) - regionMask(x, y, r))).toBeLessThan(maxStep);
        }
      }
    }
  });

  it("falls back to top right for unknown presets", () => {
    expect(layout("nope")).toEqual(layout("topRight"));
    expect(layout("constructor")).toEqual(layout("topRight"));
  });
});

describe("frameMask", () => {
  it("darkens the cross by the full depth and leaves the rest alone", () => {
    const r = layoutRegion(createRegionLayout(), "topRight", 1920);
    expect(frameMask(r.frameX, 500, r)).toBeCloseTo(1 - FRAME_DEPTH, 10);
    expect(frameMask(100, r.frameY, r)).toBeCloseTo(1 - FRAME_DEPTH, 10);
    expect(frameMask(r.frameX - 200, r.frameY + 200, r)).toBe(1);
  });
});

describe("layer drift", () => {
  it("doesn't swing the pattern when the sun angle changes, even after a day", () => {
    const basis = new Float64Array(4);
    sunBasis(basis, 20);
    const drift = new Float64Array(2);
    const scale = 1 / 300;
    for (let i = 0; i < 24 * 3600; i++) {
      advanceLayerDrift(drift, 0, DRIFT_SPEED, scale, basis);
    }
    const base = [0.13, 0.57];
    const before = new Float64Array(2);
    layerOffset(before, 0, base, drift, scale, basis, 0, 0);
    sunBasis(basis, 21);
    const after = new Float64Array(2);
    layerOffset(after, 0, base, drift, scale, basis, 0, 0);
    expect(Math.abs(after[0] - before[0])).toBeLessThan(1e-3);
    expect(Math.abs(after[1] - before[1])).toBeLessThan(1e-3);
  });

  it("drifts at the same rate as the total distance would give, and wraps", () => {
    const basis = new Float64Array(4);
    sunBasis(basis, 0);
    const drift = new Float64Array(2);
    for (let i = 0; i < 100; i++) {
      advanceLayerDrift(drift, 0, 0.5, 0.01, basis);
    }
    // 50 ref px at 0.01 tiles per px, straight across: half a tile.
    expect(drift[0]).toBeCloseTo(0.5, 9);
    expect(drift[1]).toBeCloseTo(0, 9);
    for (let i = 0; i < 1000; i++) {
      advanceLayerDrift(drift, 0, 0.5, 0.01, basis);
      expect(drift[0]).toBeGreaterThanOrEqual(0);
      expect(drift[0]).toBeLessThan(1);
    }
  });
});
