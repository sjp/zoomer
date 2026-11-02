import { describe, expect, it } from "vitest";
import { coverageThreshold, layerUniforms } from "./clouds";
import {
  buildNoiseTexture,
  buildPresetTable,
  createPresetTransition,
  lerpPreset,
  P,
  PRESET_STRIDE,
  PRESETS,
  presetIndex,
  TIME_OPTIONS,
  transitionWeight,
} from "./clouds-sky";

const SIZE = 64;
const tex = buildNoiseTexture(SIZE, 3);
const at = (x: number, y: number, c: number) => tex[(y * SIZE + x) * 4 + c];

/** Mean |difference| between texel (x, y) and its neighbour at (x + dx, y + dy), wrapping. */
const meanStep = (c: number, pick: (i: number) => [number, number, number, number]) => {
  let sum = 0;
  for (let i = 0; i < SIZE; i++) {
    const [x0, y0, x1, y1] = pick(i);
    sum += Math.abs(at(x0, y0, c) - at(x1, y1, c));
  }
  return sum / SIZE;
};

describe("buildNoiseTexture", () => {
  it("has size x size RGBA texels and uses a wide value range around mid-grey", () => {
    expect(tex).toHaveLength(SIZE * SIZE * 4);
    for (let c = 0; c < 4; c++) {
      let min = 255;
      let max = 0;
      let sum = 0;
      for (let i = 0; i < SIZE * SIZE; i++) {
        const v = tex[i * 4 + c];
        min = Math.min(min, v);
        max = Math.max(max, v);
        sum += v;
      }
      expect(max - min).toBeGreaterThan(100);
      expect(Math.abs(sum / (SIZE * SIZE) - 127.5)).toBeLessThan(20);
    }
  });

  it("tiles seamlessly at the edges", () => {
    for (let c = 0; c < 4; c++) {
      // Steps across the seam are no larger than steps just inside it.
      const seamX = meanStep(c, (y) => [SIZE - 1, y, 0, y]);
      const innerX = meanStep(c, (y) => [SIZE - 2, y, SIZE - 1, y]);
      const seamY = meanStep(c, (x) => [x, SIZE - 1, x, 0]);
      const innerY = meanStep(c, (x) => [x, SIZE - 2, x, SIZE - 1]);
      expect(seamX).toBeLessThan(innerX * 1.6 + 2);
      expect(seamY).toBeLessThan(innerY * 1.6 + 2);
    }
  });

  it("has decorrelated channels and is deterministic", () => {
    const n = SIZE * SIZE;
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        let sa = 0;
        let sb = 0;
        let sab = 0;
        let saa = 0;
        let sbb = 0;
        for (let i = 0; i < n; i++) {
          const x = tex[i * 4 + a];
          const y = tex[i * 4 + b];
          sa += x;
          sb += y;
          sab += x * y;
          saa += x * x;
          sbb += y * y;
        }
        const cov = sab / n - (sa / n) * (sb / n);
        const r = cov / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2));
        expect(Math.abs(r)).toBeLessThan(0.2);
      }
    }
    expect(buildNoiseTexture(SIZE, 3)).toEqual(tex);
  });
});

describe("preset table", () => {
  const table = buildPresetTable();

  it("has one row per time option, colours in 0..1, unit light directions", () => {
    expect(table).toHaveLength(TIME_OPTIONS.length * PRESET_STRIDE);
    for (let i = 0; i < TIME_OPTIONS.length; i++) {
      const o = i * PRESET_STRIDE;
      for (let k = 0; k < 15; k++) {
        expect(table[o + k]).toBeGreaterThanOrEqual(0);
        expect(table[o + k]).toBeLessThanOrEqual(1);
      }
      expect(Math.hypot(table[o + P.lightX], table[o + P.lightY])).toBeCloseTo(1, 5);
      expect(table[o + P.glowRadius]).toBeGreaterThan(0);
    }
  });

  it("matches the preset definitions", () => {
    const o = presetIndex("night") * PRESET_STRIDE;
    expect(table[o + P.skyTop]).toBeCloseTo(0x05 / 255, 6);
    expect(table[o + P.sunX]).toBeCloseTo(PRESETS.night.sunX, 6);
    // Clouds are brighter on the lit side than in shadow in every preset.
    for (let i = 0; i < TIME_OPTIONS.length; i++) {
      const r = i * PRESET_STRIDE;
      const lum = (k: number) => table[r + k] + table[r + k + 1] + table[r + k + 2];
      expect(lum(P.cloudLight)).toBeGreaterThan(lum(P.cloudShadow));
      expect(lum(P.skyBottom)).toBeGreaterThan(lum(P.skyTop));
    }
  });

  it("maps time values to rows, falling back to day", () => {
    expect(presetIndex("day")).toBe(0);
    expect(presetIndex("golden")).toBe(1);
    expect(presetIndex("dusk")).toBe(2);
    expect(presetIndex("night")).toBe(3);
    expect(presetIndex("bogus")).toBe(0);
  });
});

describe("preset interpolation", () => {
  const table = buildPresetTable();
  const row = (i: number) => table.slice(i * PRESET_STRIDE, (i + 1) * PRESET_STRIDE);

  it("transitionWeight eases from 0 to 1 and clamps", () => {
    expect(transitionWeight(-1, 2)).toBe(0);
    expect(transitionWeight(0, 2)).toBe(0);
    expect(transitionWeight(1, 2)).toBeCloseTo(0.5, 10);
    expect(transitionWeight(0.5, 2)).toBeLessThan(0.25);
    expect(transitionWeight(2, 2)).toBe(1);
    expect(transitionWeight(5, 2)).toBe(1);
    expect(transitionWeight(0, 0)).toBe(1);
    for (let e = 0; e < 2; e += 0.1) {
      expect(transitionWeight(e + 0.1, 2)).toBeGreaterThanOrEqual(transitionWeight(e, 2));
    }
  });

  it("lerpPreset interpolates rows and supports aliasing", () => {
    const out = new Float32Array(PRESET_STRIDE);
    expect(lerpPreset(out, table, 0, table, PRESET_STRIDE, 0)).toBe(out);
    expect(out).toEqual(row(0));
    lerpPreset(out, table, 0, table, PRESET_STRIDE, 1);
    expect(out).toEqual(row(1));
    lerpPreset(out, table, 0, table, PRESET_STRIDE, 0.25);
    for (let i = 0; i < PRESET_STRIDE; i++) {
      expect(out[i]).toBeCloseTo(table[i] + (table[PRESET_STRIDE + i] - table[i]) * 0.25, 5);
    }
    const a = row(2);
    lerpPreset(a, a, 0, table, 3 * PRESET_STRIDE, 0.5);
    expect(a[P.sunX]).toBeCloseTo((PRESETS.dusk.sunX + PRESETS.night.sunX) / 2, 5);
  });

  it("snaps on the first update, then blends over the duration", () => {
    const tr = createPresetTransition(table, 2);
    const values = tr.values;
    expect(tr.update(0.016, 1)).toBe(true);
    expect(tr.values).toEqual(row(1));
    expect(tr.update(0.016, 1)).toBe(false);

    expect(tr.update(1, 3)).toBe(true);
    for (let i = 0; i < PRESET_STRIDE; i++) {
      const mid =
        table[PRESET_STRIDE + i] + (table[3 * PRESET_STRIDE + i] - table[PRESET_STRIDE + i]) * 0.5;
      expect(tr.values[i]).toBeCloseTo(mid, 5);
    }
    expect(tr.update(1, 3)).toBe(true);
    expect(tr.values).toEqual(row(3));
    expect(tr.update(1, 3)).toBe(false);
    // Always the same buffer: nothing is allocated per update.
    expect(tr.values).toBe(values);
  });

  it("restarts from the current blend when interrupted, without jumping", () => {
    const tr = createPresetTransition(table, 2);
    tr.update(0, 0);
    tr.update(1, 2);
    const mid = tr.values.slice();
    // Switching target mid-blend with dt = 0 keeps the current values.
    tr.update(0, 1);
    expect(tr.values).toEqual(mid);
    tr.update(2, 1);
    expect(tr.values).toEqual(row(1));
  });

  it("ignores negative dt", () => {
    const tr = createPresetTransition(table, 2);
    tr.update(0, 0);
    tr.update(-5, 1);
    expect(tr.values).toEqual(row(0));
  });
});

describe("layerUniforms", () => {
  const offA = new Float32Array(8);
  const detail = new Float32Array(8);
  const params = new Float32Array(8);

  it("keeps offsets wrapped and cross-fade weights in range", () => {
    for (let t = 0; t < 200; t += 0.37) {
      layerUniforms(offA, detail, params, 4, 1, t * 0.01, t, 1.2, 0.8);
      for (let i = 4; i < 8; i++) {
        expect(offA[i]).toBeGreaterThanOrEqual(0);
        expect(offA[i]).toBeLessThanOrEqual(1);
      }
      expect(params[4]).toBeCloseTo(1.2, 6);
      expect(params[5]).toBeGreaterThanOrEqual(0);
      expect(params[5]).toBeLessThanOrEqual(1);
      expect(params[6]).toBeGreaterThanOrEqual(1);
      expect(params[6]).toBeLessThanOrEqual(Math.SQRT2 + 1e-6);
      expect(params[7]).toBeCloseTo(0.8, 6);
    }
  });

  it("only re-randomises a sample while its weight is zero", () => {
    // With no wind, a sample's x offset only changes when it re-randomises,
    // and its weight must be ~0 at that moment.
    let prev = new Float32Array(8);
    layerUniforms(prev, detail, params, 0, 0, 0, 0, 1, 1);
    let prevW = params[1];
    let jumps = 0;
    let worst = 0;
    for (let t = 0.01; t < 120; t += 0.01) {
      layerUniforms(offA, detail, params, 0, 0, 0, t, 1, 1);
      const wa = params[1];
      const jumpA = offA[0] !== prev[0] ? 1 : 0;
      const jumpB = offA[2] !== prev[2] ? 1 : 0;
      jumps += jumpA + jumpB;
      worst = Math.max(worst, jumpA * Math.min(wa, prevW), jumpB * Math.min(1 - wa, 1 - prevW));
      prev = offA.slice();
      prevW = wa;
    }
    expect(jumps).toBeGreaterThanOrEqual(6);
    expect(worst).toBeLessThan(0.01);
  });
});

describe("coverageThreshold", () => {
  it("decreases with coverage and clamps", () => {
    expect(coverageThreshold(0)).toBeGreaterThan(coverageThreshold(0.5));
    expect(coverageThreshold(0.5)).toBeGreaterThan(coverageThreshold(1));
    expect(coverageThreshold(-1)).toBe(coverageThreshold(0));
    expect(coverageThreshold(2)).toBe(coverageThreshold(1));
  });
});
