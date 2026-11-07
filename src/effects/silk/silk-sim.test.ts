import { describe, expect, it } from "vitest";
import {
  advancePhases,
  baseWavelength,
  fillWarpUniforms,
  fillWaveUniforms,
  LAYOUT_WAVES,
  layoutWaves,
  lightVectors,
  REF_ASPECT,
  SILK_LAYOUTS,
  silkField,
  type SilkSample,
  WARP_K,
  WARP_WAVES,
  WARPS,
  WAVE_FLOATS,
  WAVES,
} from "./silk-sim";
import { MAX_BREEZE, MAX_FOLDS, MIN_FOLDS } from "./silk.meta";

const TAU = Math.PI * 2;

function arrays(layout: string, folds: number, phase = 0.3) {
  const specs = layoutWaves(layout);
  const phases = new Float64Array(WAVES).fill(phase);
  const warpPhases = new Float64Array(WARPS).fill(-phase);
  const waves = new Float32Array(WAVES * WAVE_FLOATS);
  const warp = new Float32Array(WARPS * WAVE_FLOATS);
  fillWaveUniforms(waves, specs, folds, phases);
  fillWarpUniforms(warp, folds, warpPhases);
  return { waves, warp };
}

const sample = (): SilkSample => ({ h: 0, gx: 0, gy: 0 });

describe("silkField", () => {
  it.each(SILK_LAYOUTS.flatMap((l) => [MIN_FOLDS, 6, MAX_FOLDS].map((f) => [l, f] as const)))(
    "%s at %d folds: the analytic gradient matches a finite difference",
    (layout, folds) => {
      const { waves, warp } = arrays(layout, folds);
      const e = 1e-6;
      const s = sample();
      const a = sample();
      const b = sample();
      for (let i = 0; i < 40; i++) {
        const x = ((i * 0.37) % 1.8) - 0.9;
        const y = ((i * 0.61) % 1) - 0.5;
        silkField(waves, warp, x, y, s);
        const dx =
          (silkField(waves, warp, x + e, y, a).h - silkField(waves, warp, x - e, y, b).h) / (2 * e);
        const dy =
          (silkField(waves, warp, x, y + e, a).h - silkField(waves, warp, x, y - e, b).h) / (2 * e);
        const scale = Math.max(1, Math.hypot(s.gx, s.gy));
        expect(Math.abs(s.gx - dx) / scale).toBeLessThan(1e-5);
        expect(Math.abs(s.gy - dy) / scale).toBeLessThan(1e-5);
      }
    },
  );
});

describe("wave sets", () => {
  it.each(SILK_LAYOUTS)("%s has %d waves whose amplitudes sum to 1, so |h| <= 1", (layout) => {
    const specs = LAYOUT_WAVES[layout];
    expect(specs).toHaveLength(WAVES);
    const sum = specs.reduce((s, w) => s + Math.abs(w.amp), 0);
    expect(sum).toBeCloseTo(1, 12);
    const { waves, warp } = arrays(layout, 6);
    const s = sample();
    for (let i = 0; i < 200; i++) {
      expect(
        Math.abs(silkField(waves, warp, (i % 20) * 0.09 - 0.9, i * 0.005 - 0.5, s).h),
      ).toBeLessThanOrEqual(1);
    }
  });

  it.each(SILK_LAYOUTS)("%s folds are at least 80 px wide at 1080p at the most folds", (layout) => {
    const shortest =
      Math.min(...LAYOUT_WAVES[layout].map((w) => w.length)) * baseWavelength(MAX_FOLDS);
    expect(shortest * 1080).toBeGreaterThanOrEqual(80);
  });

  it.each(SILK_LAYOUTS)(
    "%s moves slowly: every cycle takes a few seconds at full breeze",
    (layout) => {
      for (const w of [...LAYOUT_WAVES[layout], ...WARP_WAVES]) {
        expect(Math.abs(w.period) / MAX_BREEZE).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it("the warp never folds space over (|dW/dp| < 1) at the fewest folds", () => {
    for (const w of WARP_WAVES) {
      expect(WARP_K * baseWavelength(MIN_FOLDS) * (TAU / w.length)).toBeLessThan(1);
    }
  });

  it("counts folds across a 16:9 frame and clamps the count", () => {
    expect(baseWavelength(8)).toBeCloseTo(REF_ASPECT / 8, 12);
    expect(baseWavelength(100)).toBe(baseWavelength(MAX_FOLDS));
    expect(baseWavelength(0)).toBe(baseWavelength(MIN_FOLDS));
    expect(baseWavelength(Number.NaN)).toBe(baseWavelength(MIN_FOLDS));
  });

  it("falls back to hanging for unknown layouts", () => {
    expect(layoutWaves("nope")).toBe(LAYOUT_WAVES.hanging);
    expect(layoutWaves("flowing")).toBe(LAYOUT_WAVES.flowing);
  });
});

describe("advancePhases", () => {
  it("wraps into [-pi, pi) and stays continuous with the unwrapped phase", () => {
    const specs = LAYOUT_WAVES.flowing;
    const phases = new Float64Array(WAVES);
    const unwrapped = new Float64Array(WAVES);
    const dt = 1 / 60;
    let lo = Infinity;
    let hi = -Infinity;
    let maxError = 0;
    let maxStep = 0;
    const before = new Float64Array(WAVES);
    for (let f = 0; f < 60 * 600; f++) {
      before.set(phases);
      advancePhases(phases, specs, dt);
      for (let i = 0; i < WAVES; i++) {
        unwrapped[i] += (TAU * dt) / specs[i].period;
        lo = Math.min(lo, phases[i]);
        hi = Math.max(hi, phases[i]);
        maxError = Math.max(
          maxError,
          Math.abs(Math.sin(phases[i]) - Math.sin(unwrapped[i])),
          Math.abs(Math.cos(phases[i]) - Math.cos(unwrapped[i])),
        );
        maxStep = Math.max(maxStep, Math.abs(Math.sin(phases[i]) - Math.sin(before[i])));
      }
    }
    expect(lo).toBeGreaterThanOrEqual(-Math.PI);
    expect(hi).toBeLessThan(Math.PI);
    expect(maxError).toBeLessThan(1e-9);
    // No jump at the wrap: the largest per-frame change is one frame's travel.
    expect(maxStep).toBeLessThanOrEqual((TAU * dt) / 7.5 + 1e-12);
  });

  it("does nothing at zero breeze", () => {
    const phases = new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    advancePhases(phases, LAYOUT_WAVES.hanging, 0);
    expect([...phases]).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
  });

  it("uploads wrapped phases including each wave's start phase", () => {
    const { waves, warp } = arrays("billowing", 6, 3.1);
    for (let i = 0; i < WAVES; i++) {
      const ph = waves[i * WAVE_FLOATS + 2];
      expect(Math.abs(ph)).toBeLessThanOrEqual(Math.PI + 1e-6);
      expect(Math.sin(ph)).toBeCloseTo(Math.sin(3.1 + LAYOUT_WAVES.billowing[i].phase), 5);
    }
    for (let i = 0; i < WARPS; i++) {
      expect(Math.abs(warp[i * WAVE_FLOATS + 2])).toBeLessThanOrEqual(Math.PI + 1e-6);
    }
  });
});

describe("lightVectors", () => {
  it("gives unit L and H, with H halfway between L and the view", () => {
    const out = new Float32Array(6);
    for (const angle of [0, 90, 120, 270]) {
      lightVectors(out, angle);
      expect(Math.hypot(out[0], out[1], out[2])).toBeCloseTo(1, 6);
      expect(Math.hypot(out[3], out[4], out[5])).toBeCloseTo(1, 6);
      const hl = out[0] * out[3] + out[1] * out[4] + out[2] * out[5];
      expect(hl).toBeCloseTo(out[5], 6);
    }
    lightVectors(out, 90);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeGreaterThan(0);
  });
});
