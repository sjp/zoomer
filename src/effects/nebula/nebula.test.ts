import { describe, expect, it } from "vitest";
import {
  buildStars,
  coreCentre,
  coverRadius,
  createLayout,
  densityThreshold,
  gasAmount,
  getNoiseData,
  MAX_STARS,
  NOISE_SIZE,
  OFFSET_FLOATS,
  offsetsAt,
  PALETTES,
  paletteColor,
  rotationAt,
  sampleNoise,
  SPIKE_MIN,
  SPIKE_STARS,
  STAR_ALPHA,
  STAR_MAX,
  STAR_MIN,
  STAR_STRIDE,
  starBrightness,
  starDim,
} from "./nebula-sim";
import { firstDifference } from "../../test/bytes";
import { createRng } from "../noise";

describe("paletteColor", () => {
  it("returns preset colours by index", () => {
    expect(paletteColor("orion", 0, "a", "b", "c")).toBe(PALETTES.orion[0]);
    expect(paletteColor("carina", 1, "a", "b", "c")).toBe(PALETTES.carina[1]);
    expect(paletteColor("veil", 2, "a", "b", "c")).toBe(PALETTES.veil[2]);
  });
  it("uses the custom colours for custom", () => {
    expect(paletteColor("custom", 0, "a", "b", "c")).toBe("a");
    expect(paletteColor("custom", 1, "a", "b", "c")).toBe("b");
    expect(paletteColor("custom", 2, "a", "b", "c")).toBe("c");
  });
  it("falls back to Orion and clamps the index", () => {
    expect(paletteColor("nope", 1, "a", "b", "c")).toBe(PALETTES.orion[1]);
    expect(paletteColor("constructor", 0, "a", "b", "c")).toBe(PALETTES.orion[0]);
    expect(paletteColor("veil", 7, "a", "b", "c")).toBe(PALETTES.veil[2]);
    expect(paletteColor("veil", -1, "a", "b", "c")).toBe(PALETTES.veil[0]);
  });
});

describe("starBrightness", () => {
  it("follows the power law P(b > x) = (x / min)^-alpha below the cap", () => {
    const rng = createRng(5);
    const n = 200_000;
    const samples = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = starBrightness(rng());
    }
    for (const x of [0.3, 0.6, 1.2, 2.4]) {
      let above = 0;
      for (const b of samples) {
        if (b > x) {
          above++;
        }
      }
      const expected = (x / STAR_MIN) ** -STAR_ALPHA;
      expect(above / n).toBeGreaterThan(expected * 0.93);
      expect(above / n).toBeLessThan(expected * 1.07);
    }
  });
  it("stays within [STAR_MIN, STAR_MAX]", () => {
    expect(starBrightness(0)).toBeCloseTo(STAR_MIN);
    expect(starBrightness(0.999999999)).toBe(STAR_MAX);
    expect(starBrightness(1)).toBe(STAR_MAX);
  });
});

describe("buildStars", () => {
  const make = (seed: number, density: number, aspect: number, spikes = true) => {
    const out = new Float32Array(MAX_STARS * STAR_STRIDE);
    const r = buildStars(out, seed, density, aspect, spikes);
    return { out, ...r };
  };

  it("is deterministic for a seed and differs between seeds", () => {
    const a = make(3, 0.5, 16 / 9);
    const b = make(3, 0.5, 16 / 9);
    const c = make(4, 0.5, 16 / 9);
    expect(a.count).toBeGreaterThan(100);
    expect(firstDifference(a.out, b.out)).toBe(-1);
    expect(a.out.slice(0, 20)).not.toEqual(c.out.slice(0, 20));
  });

  it("keeps stars within the disc that covers the canvas", () => {
    const aspect = 16 / 9;
    const { out, count } = make(1, 1, aspect);
    const r = coverRadius(aspect);
    for (let i = 0; i < count; i++) {
      const o = i * STAR_STRIDE;
      expect(Math.hypot(out[o], out[o + 1])).toBeLessThanOrEqual(r + 1e-6);
    }
  });

  it("adds stars without moving the others as the density rises", () => {
    const lo = make(2, 0.3, 16 / 9, false);
    const hi = make(2, 0.6, 16 / 9, false);
    expect(hi.count).toBeGreaterThan(lo.count);
    expect(hi.out.slice(0, lo.count * STAR_STRIDE)).toEqual(
      lo.out.slice(0, lo.count * STAR_STRIDE),
    );
  });

  it("writes no stars at zero density", () => {
    expect(make(1, 0, 16 / 9).count).toBe(0);
  });

  it("follows the brightness power law", () => {
    const { out, count } = make(9, 1, 3, false);
    let above = 0;
    const x = 0.6;
    for (let i = 0; i < count; i++) {
      if (out[i * STAR_STRIDE + 3] > x) {
        above++;
      }
    }
    const expected = (x / STAR_MIN) ** -STAR_ALPHA;
    expect(above / count).toBeGreaterThan(expected * 0.75);
    expect(above / count).toBeLessThan(expected * 1.25);
  });

  it("puts the brightest on-screen spike stars first, outside the middle third", () => {
    const aspect = 16 / 9;
    const { out, count, spikes } = make(1, 1, aspect);
    expect(spikes).toBeGreaterThan(0);
    expect(spikes).toBeLessThanOrEqual(SPIKE_STARS);
    expect(spikes).toBe(SPIKE_STARS);
    let prev = Infinity;
    for (let k = 0; k < spikes; k++) {
      const o = k * STAR_STRIDE;
      expect(out[o + 3]).toBeGreaterThanOrEqual(SPIKE_MIN);
      expect(out[o + 3]).toBeLessThanOrEqual(prev);
      expect(Math.abs(out[o])).toBeGreaterThan(aspect / 6);
      expect(Math.abs(out[o])).toBeLessThan(aspect / 2);
      prev = out[o + 3];
    }
    // No eligible star brighter than the last spike star was left out.
    let brighterLeftOut = 0;
    for (let i = spikes; i < count; i++) {
      const o = i * STAR_STRIDE;
      const ax = Math.abs(out[o]);
      const eligible = ax > aspect / 6 && ax < aspect / 2 - 0.02 && Math.abs(out[o + 1]) <= 0.48;
      if (eligible && out[o + 3] > prev) {
        brighterLeftOut++;
      }
    }
    expect(brighterLeftOut).toBe(0);
    expect(make(1, 1, aspect, false).spikes).toBe(0);
  });

  it("applies the dimming function to brightness", () => {
    const out = new Float32Array(MAX_STARS * STAR_STRIDE);
    const plain = make(5, 0.4, 16 / 9, false);
    const r = buildStars(out, 5, 0.4, 16 / 9, false, () => 0.5);
    expect(r.count).toBe(plain.count);
    expect(out[3]).toBeCloseTo(plain.out[3] * 0.5, 5);
  });
});

describe("layout and drift", () => {
  it("places the core in an outer third", () => {
    const core = new Float64Array(2);
    for (let seed = 0; seed < 50; seed++) {
      const aspect = 16 / 9;
      coreCentre(createLayout(seed), aspect, core);
      expect(Math.abs(core[0])).toBeGreaterThan(aspect / 6);
      expect(Math.abs(core[0])).toBeLessThan(aspect / 2);
    }
  });

  it("wraps offsets to [0, 1) and moves them slowly", () => {
    const layout = createLayout(3);
    const a = new Float64Array(OFFSET_FLOATS);
    const b = new Float64Array(OFFSET_FLOATS);
    offsetsAt(layout, 1e7, a);
    for (const v of a) {
      expect(v >= 0 && v < 1).toBe(true);
    }
    offsetsAt(layout, 100, a);
    offsetsAt(layout, 101, b);
    for (let i = 0; i < OFFSET_FLOATS; i++) {
      const d = Math.abs(a[i] - b[i]);
      expect(Math.min(d, 1 - d)).toBeLessThan(0.01);
    }
  });

  it("rotates about a degree a minute, wrapped", () => {
    expect(rotationAt(60)).toBeCloseTo(Math.PI / 180, 10);
    const r = rotationAt(1e9);
    expect(r >= 0 && r < Math.PI * 2).toBe(true);
  });
});

describe("gas twin", () => {
  const data = getNoiseData();

  it("samples the noise texture bilinearly with wrapping", () => {
    const out = new Float64Array(4);
    // At a texel centre the sample is that texel.
    sampleNoise(data, NOISE_SIZE, 0.5 / NOISE_SIZE, 0.5 / NOISE_SIZE, out);
    expect(out[0]).toBeCloseTo(data[0] / 255, 10);
    const wrapped = new Float64Array(4);
    sampleNoise(data, NOISE_SIZE, 3.5 / NOISE_SIZE + 2, 0.5 / NOISE_SIZE - 1, wrapped);
    sampleNoise(data, NOISE_SIZE, 3.5 / NOISE_SIZE, 0.5 / NOISE_SIZE, out);
    expect(wrapped[1]).toBeCloseTo(out[1], 6);
  });

  it("gives more gas at higher density, less with dust, and dims stars accordingly", () => {
    const layout = createLayout(1);
    const offsets = new Float64Array(OFFSET_FLOATS);
    offsetsAt(layout, 0, offsets);
    const core = new Float64Array(2);
    coreCentre(layout, 16 / 9, core);
    let lo = 0;
    let hi = 0;
    let dusty = 0;
    for (let i = 0; i < 400; i++) {
      const x = ((i % 20) / 20 - 0.5) * 1.7;
      const y = (Math.floor(i / 20) / 20 - 0.5) * 0.95;
      lo += gasAmount(data, x, y, offsets, densityThreshold(0.2), 0, core);
      hi += gasAmount(data, x, y, offsets, densityThreshold(0.9), 0, core);
      dusty += gasAmount(data, x, y, offsets, densityThreshold(0.9), 0.9, core);
    }
    expect(hi).toBeGreaterThan(lo);
    expect(dusty).toBeLessThan(hi);
    expect(starDim(0)).toBe(1);
    expect(starDim(10)).toBeLessThan(starDim(1));
    expect(starDim(100)).toBeGreaterThan(0.4);
  });
});
