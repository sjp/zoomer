import { describe, expect, it } from "vitest";
import { createNoise, createRng } from "./noise";
import {
  bandSpeed,
  BIRD_FLOATS,
  COLUMNS,
  createFlock,
  fillLayout,
  fillRidgeTable,
  fogDensity,
  LAYER_FLOATS,
  latticePeriod,
  layerCount,
  layerShape,
  MAX_BIRDS,
  PALETTES,
  paletteFor,
  parallax,
  ridgeHeightAt,
  ridgeRaw,
  SPAN,
  stepFlock,
  writeBirds,
} from "./ridges-sim";
import { PALETTE_OPTIONS, MAX_LAYERS, MIN_LAYERS } from "./ridges.meta";

const buildTable = (count: number, seed: number, peaks: number) => {
  const out = new Float32Array(MAX_LAYERS * COLUMNS);
  fillRidgeTable(out, count, seed, peaks);
  return out;
};

describe("palettes", () => {
  it("has an option for every palette and falls back to ink wash", () => {
    expect(PALETTE_OPTIONS.map((o) => o.value).sort()).toEqual(Object.keys(PALETTES).sort());
    expect(paletteFor("jade")).toBe(PALETTES.jade);
    expect(paletteFor("nope")).toBe(PALETTES.ink);
    expect(paletteFor("toString")).toBe(PALETTES.ink);
  });
});

describe("layerCount", () => {
  it("clamps and rounds", () => {
    expect(layerCount(0)).toBe(MIN_LAYERS);
    expect(layerCount(5.4)).toBe(5);
    expect(layerCount(99)).toBe(MAX_LAYERS);
    expect(layerCount(Number.NaN)).toBe(MIN_LAYERS);
  });
});

describe("ridgeRaw", () => {
  it.each([0, 0.5, 1])("is periodic with period 1 at peaks %f", (peaks) => {
    const noise = createNoise(3);
    for (const p0 of [5, 13]) {
      for (const u of [0, 0.123, 0.5, 0.987]) {
        expect(ridgeRaw(noise, u + 1, p0, peaks)).toBeCloseTo(ridgeRaw(noise, u, p0, peaks), 9);
      }
    }
  });

  it("uses a whole number of lattice cells per period", () => {
    for (let i = 0; i < MAX_LAYERS; i++) {
      const p = latticePeriod(layerShape(i, MAX_LAYERS).wavelength);
      expect(Number.isInteger(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("fillRidgeTable", () => {
  it.each([MIN_LAYERS, 5, MAX_LAYERS])("keeps %i layers' heights in their bands", (n) => {
    for (const peaks of [0, 0.7, 1]) {
      const t = buildTable(n, 4, peaks);
      for (let i = 0; i < n; i++) {
        const { base, amp } = layerShape(i, n);
        let lo = Infinity;
        let hi = -Infinity;
        for (let c = 0; c < COLUMNS; c++) {
          const h = t[i * COLUMNS + c];
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
        expect(lo).toBeCloseTo(base, 5);
        expect(hi).toBeCloseTo(base + amp, 5);
      }
      for (let c = 0; c < (MAX_LAYERS - n) * COLUMNS; c++) expect(t[n * COLUMNS + c]).toBe(0);
    }
  });

  it("wraps: the column after the last matches the first one period on", () => {
    const t = buildTable(6, 9, 0.7);
    for (let i = 0; i < 6; i++) {
      for (const x of [0, 0.37, 1.5, 3.99]) {
        expect(ridgeHeightAt(t, i, x + SPAN)).toBeCloseTo(ridgeHeightAt(t, i, x), 6);
      }
      // Table ends join smoothly: no larger step across the seam than elsewhere.
      const row = i * COLUMNS;
      let maxStep = 0;
      for (let c = 1; c < COLUMNS; c++) {
        maxStep = Math.max(maxStep, Math.abs(t[row + c] - t[row + c - 1]));
      }
      expect(Math.abs(t[row] - t[row + COLUMNS - 1])).toBeLessThanOrEqual(maxStep * 1.01);
    }
  });

  it("is deterministic and depends on the seed", () => {
    expect(buildTable(5, 2, 0.5)).toEqual(buildTable(5, 2, 0.5));
    expect(buildTable(5, 2, 0.5)).not.toEqual(buildTable(5, 3, 0.5));
  });
});

describe("layer order", () => {
  it.each([MIN_LAYERS, 5, 6, MAX_LAYERS])("never puts a far layer below a near one (%i)", (n) => {
    for (let i = 1; i < n; i++) {
      const near = layerShape(i - 1, n);
      const far = layerShape(i, n);
      expect(far.base).toBeGreaterThan(near.base);
      expect(far.base + far.amp).toBeGreaterThan(near.base + near.amp);
      expect(far.haze).toBeGreaterThan(near.haze);
      expect(parallax(i, n)).toBeLessThan(parallax(i - 1, n));
    }
    expect(layerShape(0, n).haze).toBe(0);
  });
});

describe("fogDensity", () => {
  it("is 1 at and below the floor, 0 at the top, and bounded", () => {
    expect(fogDensity(-1)).toBe(1);
    expect(fogDensity(0)).toBe(1);
    expect(fogDensity(1)).toBe(0);
    expect(fogDensity(5)).toBe(0);
    expect(fogDensity(Number.NaN)).toBe(1);
    for (let t = -0.5; t <= 1.5; t += 0.01) {
      expect(fogDensity(t)).toBeGreaterThanOrEqual(0);
      expect(fogDensity(t)).toBeLessThanOrEqual(1);
    }
  });

  it("is continuous and falls monotonically", () => {
    const d = 1e-4;
    let prev = fogDensity(-0.1);
    for (let t = -0.1 + d; t <= 1.1; t += d) {
      const v = fogDensity(t);
      expect(Math.abs(v - prev)).toBeLessThan(2 * d);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
  });
});

describe("fillLayout", () => {
  it("lays out rows, haze and fog bands that overlap at most two deep", () => {
    const layers = new Float32Array(MAX_LAYERS * LAYER_FLOATS).fill(9);
    const bands = new Float32Array(MAX_LAYERS * LAYER_FLOATS).fill(9);
    const n = 6;
    fillLayout(layers, bands, n);
    for (let i = 0; i < n; i++) {
      const o = i * LAYER_FLOATS;
      expect(layers[o + 1]).toBeCloseTo((i + 0.5) / MAX_LAYERS, 6);
      expect(layers[o + 2]).toBeCloseTo(layerShape(i, n).haze, 6);
      expect(bands[o + 1]).toBeGreaterThan(0);
    }
    for (let i = 1; i < n; i++) {
      expect(bands[i * LAYER_FLOATS]).toBeGreaterThan(bands[(i - 1) * LAYER_FLOATS]);
    }
    for (let o = n * LAYER_FLOATS; o < layers.length; o++) {
      expect(layers[o]).toBe(0);
      expect(bands[o]).toBe(0);
    }
    // At any height, at most two bands are in their fading part (0 < t < 1).
    for (let y = 0; y < 1; y += 0.002) {
      let fading = 0;
      for (let i = 0; i < n; i++) {
        const t = (y - bands[i * LAYER_FLOATS]) * bands[i * LAYER_FLOATS + 1];
        if (t > 0 && t < 1) fading++;
      }
      expect(fading).toBeLessThanOrEqual(2);
    }
  });

  it("gives every band a positive speed", () => {
    for (let i = 0; i < MAX_LAYERS; i++) expect(bandSpeed(i, MAX_LAYERS)).toBeGreaterThan(0);
  });
});

describe("flock", () => {
  it("waits, flies a V across and retires it", () => {
    const f = createFlock(2);
    const rand = createRng(5);
    const out = new Float32Array(MAX_BIRDS * BIRD_FLOATS);
    const aspect = 16 / 9;
    stepFlock(f, 1, aspect, rand);
    expect(f.count).toBe(0);
    stepFlock(f, 1.5, aspect, rand);
    expect(f.count).toBeGreaterThanOrEqual(3);
    expect(f.count).toBeLessThanOrEqual(MAX_BIRDS);
    const n = writeBirds(f, out, 1080, 1);
    expect(n).toBe(f.count);
    for (let b = 0; b < n; b++) {
      const o = b * BIRD_FLOATS;
      expect(out[o + 1]).toBeGreaterThan(0.6 * 1080);
      expect(out[o + 1]).toBeLessThan(1080);
      expect(out[o + 2]).toBeGreaterThan(0);
      expect(Math.abs(out[o + 3])).toBeLessThan(1);
    }
    let seconds = 0;
    while (f.count > 0 && seconds < 600) {
      stepFlock(f, 0.1, aspect, rand);
      seconds += 0.1;
    }
    expect(f.count).toBe(0);
    expect(seconds).toBeGreaterThan(20);
    expect(f.wait).toBeGreaterThan(0);
  });
});
