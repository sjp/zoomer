import { describe, expect, it } from "vitest";
import type { Rgb } from "./color";
import { createSkyState } from "./horizon-sim";
import {
  advanceSwellPhases,
  buildHeadland,
  buildRippleSlopes,
  LAND_COLUMNS,
  LAND_HEIGHT,
  LAND_TIP,
  landColor,
  presetSky,
  resolveSwells,
  schlick,
  SEA_PRESETS,
  seaPreset,
  swellBound,
  swellGradient,
  swellHeight,
  WATER_F0,
} from "./sea-sim";

const TAU = Math.PI * 2;
const waves = resolveSwells();

describe("swell", () => {
  it("has an analytic gradient matching a finite difference", () => {
    const phases = new Float64Array([0.3, 2.1, 4.4]);
    const g: [number, number] = [0, 0];
    const e = 1e-4;
    for (const [x, z] of [
      [0, 5],
      [-12.5, 40],
      [33, 210],
      [7, 1000],
    ]) {
      swellGradient(waves, phases, 1.5, x, z, g);
      const fx =
        (swellHeight(waves, phases, 1.5, x + e, z) - swellHeight(waves, phases, 1.5, x - e, z)) /
        (2 * e);
      const fz =
        (swellHeight(waves, phases, 1.5, x, z + e) - swellHeight(waves, phases, 1.5, x, z - e)) /
        (2 * e);
      expect(g[0]).toBeCloseTo(fx, 6);
      expect(g[1]).toBeCloseTo(fz, 6);
    }
  });

  it("stays within its bound and is gentle", () => {
    const phases = new Float64Array(3);
    const bound = swellBound(waves, 2);
    expect(bound).toBeLessThan(2);
    const g: [number, number] = [0, 0];
    for (let i = 0; i < 2000; i++) {
      const x = (i * 7.31) % 300;
      const z = (i * 3.77) % 900;
      expect(Math.abs(swellHeight(waves, phases, 2, x, z))).toBeLessThanOrEqual(bound + 1e-12);
      swellGradient(waves, phases, 2, x, z, g);
      expect(Math.hypot(g[0], g[1])).toBeLessThan(0.25);
    }
  });

  it("rolls towards the viewer", () => {
    for (const w of waves) {
      expect(w.kz).toBeLessThan(0);
      expect(w.omega).toBeGreaterThan(0);
    }
  });

  it("wraps phases into [0, 2π) without changing the surface", () => {
    const wrapped = new Float64Array(3);
    const unwrapped = [0, 0, 0];
    const t = 1 / 60;
    for (let f = 0; f < 60 * 120; f++) {
      advanceSwellPhases(wrapped, waves, t);
      for (let i = 0; i < 3; i++) {
        unwrapped[i] -= waves[i].omega * t;
      }
    }
    for (let i = 0; i < 3; i++) {
      expect(wrapped[i]).toBeGreaterThanOrEqual(0);
      expect(wrapped[i]).toBeLessThan(TAU);
      // Same angle modulo 2π: the surface is continuous across every wrap.
      expect(Math.cos(wrapped[i])).toBeCloseTo(Math.cos(unwrapped[i]), 9);
      expect(Math.sin(wrapped[i])).toBeCloseTo(Math.sin(unwrapped[i]), 9);
    }
  });
});

describe("schlick", () => {
  it("is in [0, 1], F0 head-on, 1 at grazing, and falls with cos θ", () => {
    expect(schlick(1)).toBeCloseTo(WATER_F0, 12);
    expect(schlick(0)).toBe(1);
    let prev = Infinity;
    for (let i = 0; i <= 100; i++) {
      const f = schlick(i / 100);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      expect(f).toBeLessThanOrEqual(prev);
      prev = f;
    }
    expect(schlick(-1)).toBe(1);
    expect(schlick(2)).toBeCloseTo(WATER_F0, 12);
  });
});

describe("buildRippleSlopes", () => {
  const size = 32;
  const { data, rms } = buildRippleSlopes(size, 7);

  it("fills both channels, using the full range around a centred mean", () => {
    expect(data.length).toBe(size * size * 2);
    let min = 255;
    let max = 0;
    let sum = 0;
    for (const v of data) {
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
    }
    expect(min === 0 || max === 255).toBe(true);
    expect(sum / data.length).toBeGreaterThan(110);
    expect(sum / data.length).toBeLessThan(145);
    expect(rms).toBeGreaterThan(0.1);
    expect(rms).toBeLessThan(1);
  });

  it("tiles seamlessly: the wrap step is no bigger than an interior step", () => {
    const at = (x: number, y: number, c: number) => data[(y * size + x) * 2 + c];
    let interior = 0;
    let seam = 0;
    for (let y = 0; y < size; y++) {
      for (let c = 0; c < 2; c++) {
        for (let x = 0; x < size - 1; x++) {
          interior = Math.max(interior, Math.abs(at(x + 1, y, c) - at(x, y, c)));
        }
        seam = Math.max(seam, Math.abs(at(0, y, c) - at(size - 1, y, c)));
      }
    }
    expect(seam).toBeLessThanOrEqual(interior + 1);
  });

  it("is deterministic", () => {
    expect(buildRippleSlopes(size, 7).data).toEqual(data);
  });
});

describe("time presets", () => {
  const valid = (c: Rgb) => {
    for (const v of c) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  };

  for (const [name, preset] of Object.entries(SEA_PRESETS)) {
    it(`${name} yields valid colours`, () => {
      const sky = presetSky(preset, createSkyState());
      valid(sky.zenith);
      valid(sky.horizon);
      valid(sky.glow);
      expect(sky.glowStrength).toBeGreaterThanOrEqual(0);
      expect(sky.glowStrength).toBeLessThanOrEqual(1);
      valid(landColor(sky, [0, 0, 0]));
      valid(preset.deep);
      valid(preset.lightColor);
      valid(preset.discColor);
      expect(preset.roughness).toBeGreaterThan(0);
      expect(preset.intensity).toBeGreaterThanOrEqual(0);
    });
  }

  it("falls back to sunset for unknown values", () => {
    expect(seaPreset("nope")).toBe(SEA_PRESETS.sunset);
    expect(seaPreset("moonlight")).toBe(SEA_PRESETS.moonlight);
  });

  it("puts the sunset sun above the horizon and the dusk sun below it", () => {
    expect(SEA_PRESETS.sunset.lightY - SEA_PRESETS.sunset.disc).toBeGreaterThan(0);
    expect(SEA_PRESETS.dusk.lightY).toBeLessThan(0);
  });
});

describe("buildHeadland", () => {
  const out = buildHeadland(new Float32Array(LAND_COLUMNS), 43);

  it("is low, non-negative and gone past its tip", () => {
    for (let c = 0; c < LAND_COLUMNS; c++) {
      const x = c / (LAND_COLUMNS - 1);
      expect(out[c]).toBeGreaterThanOrEqual(0);
      expect(out[c]).toBeLessThanOrEqual(LAND_HEIGHT * 1.01);
      expect(x < LAND_TIP || out[c] === 0).toBe(true);
    }
    expect(out[0]).toBeGreaterThan(LAND_HEIGHT * 0.5);
  });

  it("is deterministic", () => {
    expect(buildHeadland(new Float32Array(LAND_COLUMNS), 43)).toEqual(out);
  });
});
