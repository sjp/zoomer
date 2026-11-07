import { describe, expect, it } from "vitest";
import {
  blurProfile,
  createTableScratch,
  duneShape,
  fillLayout,
  fillRidgeTable,
  HORIZON,
  horizonAngles,
  LAYOUT_FLOATS,
  ridgeShape,
  startPhase,
  SUN_AZIMUTH_HIGH,
  SUN_AZIMUTH_LOW,
  SUN_ELEVATION_MAX,
  SUN_ELEVATION_MIN,
  sunAt,
  type SunPosition,
  TABLE_CHANNELS,
  TABLE_COLUMNS,
} from "./dunes-sim";
import { MAX_RIDGES, MIN_RIDGES, MAX_CREST_SOFTNESS } from "./dunes.meta";

const tableSize = TABLE_COLUMNS * MAX_RIDGES * TABLE_CHANNELS;
const buildTable = (count: number, aspect: number, seed: number) => {
  const out = new Float32Array(tableSize);
  fillRidgeTable(out, count, aspect, seed);
  return out;
};
/** Absolute height of ridge i at column j. */
const heightAt = (t: Float32Array, i: number, j: number, count: number) =>
  ridgeShape(i, count).base + t[(i * TABLE_COLUMNS + j) * TABLE_CHANNELS];

describe("duneShape", () => {
  it("is 0 at the troughs, 1 at the crest, with flat troughs", () => {
    expect(duneShape(0)).toBe(0);
    expect(duneShape(1)).toBe(0);
    expect(duneShape(0.68)).toBeCloseTo(1, 12);
    expect(duneShape(0.01)).toBeLessThan(0.001);
    expect(duneShape(0.99)).toBeLessThan(0.01);
  });

  it.each([0.3, 1, 1.5, 2, 4])("rounds the crest at softness %f", (s) => {
    const d = 1e-4;
    let max = 0;
    let maxJump = 0;
    let sharpJump = 0;
    for (let u = d; u < 1 - d; u += d) {
      const v = duneShape(u, s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1 + 1e-12);
      max = Math.max(max, v);
      // Change in slope across one step: the sharp crest flips it at once.
      const jump = Math.abs(duneShape(u + d, s) - 2 * v + duneShape(u - d, s)) / d;
      if (u > 0.4 && u < 0.9) {
        maxJump = Math.max(maxJump, jump);
      }
      const sharp = Math.abs(duneShape(u + d) - 2 * duneShape(u) + duneShape(u - d)) / d;
      if (u > 0.4 && u < 0.9) {
        sharpJump = Math.max(sharpJump, sharp);
      }
    }
    expect(max).toBeCloseTo(1, 6);
    expect(maxJump).toBeLessThan(0.05);
    expect(sharpJump).toBeGreaterThan(1);
    // Troughs are untouched.
    expect(duneShape(0, s)).toBe(0);
    expect(duneShape(1, s)).toBe(0);
    expect(duneShape(0.01, s)).toBeLessThan(0.002);
  });
});

describe("fillRidgeTable", () => {
  it("is deterministic for a seed and differs between seeds", () => {
    const a = buildTable(4, 16 / 9, 1);
    expect(buildTable(4, 16 / 9, 1)).toEqual(a);
    // Reusing scratch buffers gives the same result.
    const scratch = createTableScratch();
    const b = new Float32Array(tableSize);
    fillRidgeTable(b, 4, 4 / 3, 1, scratch);
    fillRidgeTable(b, 4, 16 / 9, 1, scratch);
    expect(b).toEqual(a);
    expect(buildTable(4, 16 / 9, 2)).not.toEqual(a);
    expect(a.every((v) => Number.isFinite(v))).toBe(true);
  });

  it.each([3, 4, 5])("keeps %i ridges ordered, receding toward the horizon", (count) => {
    for (const aspect of [16 / 9, 4 / 3, 0.5, 3]) {
      const t = buildTable(count, aspect, 7);
      for (let i = 0; i < count; i++) {
        const shape = ridgeShape(i, count);
        let min = Infinity;
        let max = -Infinity;
        for (let j = 0; j < TABLE_COLUMNS; j++) {
          const h = heightAt(t, i, j, count);
          min = Math.min(min, h);
          max = Math.max(max, h);
        }
        expect(min).toBeGreaterThanOrEqual(shape.base - 1e-6);
        expect(max).toBeLessThanOrEqual(shape.base + shape.amp + 1e-6);
        // Below the sky's top, leaving the horizon gradient visible.
        expect(max).toBeLessThan(HORIZON + 0.05);
      }
      for (let i = 1; i < count; i++) {
        const shape = ridgeShape(i, count);
        const prev = ridgeShape(i - 1, count);
        // Behind: its troughs never dip below the nearer ridge's troughs, so it can
        // only show above that ridge. Below: smaller, tighter dunes.
        expect(shape.base).toBeGreaterThan(prev.base);
        expect(shape.amp).toBeLessThan(prev.amp);
        expect(shape.wavelength).toBeLessThan(prev.wavelength);
        for (let j = 0; j < TABLE_COLUMNS; j += 7) {
          expect(heightAt(t, i, j, count)).toBeGreaterThan(prev.base);
        }
      }
      // Unused rows stay empty.
      expect(t.subarray(count * TABLE_COLUMNS * TABLE_CHANNELS).every((v) => v === 0)).toBe(true);
    }
  });

  it("stores the slope of the profile", () => {
    const aspect = 16 / 9;
    const t = buildTable(4, aspect, 3);
    const dx = aspect / (TABLE_COLUMNS - 1);
    for (let j = 1; j < TABLE_COLUMNS - 1; j += 37) {
      const slope = t[j * TABLE_CHANNELS + 1];
      const central = (heightAt(t, 0, j + 1, 4) - heightAt(t, 0, j - 1, 4)) / (2 * dx);
      expect(slope).toBeCloseTo(central, 2);
    }
  });
});

describe("crest softness beyond the smooth min", () => {
  it("blurs a profile within its range, keeping straight lines straight", () => {
    const n = 400;
    const h = new Float64Array(n);
    const tmp = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      h[i] = i % 50 < 25 ? 0 : 1;
    }
    blurProfile(h, tmp, 6);
    expect(Math.min(...h)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...h)).toBeLessThanOrEqual(1);
    // A step becomes a ramp several samples wide.
    expect(h[25]).toBeGreaterThan(0.2);
    expect(h[25]).toBeLessThan(0.8);
    for (let i = 0; i < n; i++) {
      h[i] = 0.01 * i;
    }
    blurProfile(h, tmp, 6);
    for (let i = 30; i < n - 30; i++) {
      expect(h[i]).toBeCloseTo(0.01 * i, 9);
    }
  });

  it("keeps the ridges in range and turns the crests more gradually at the top of the slider", () => {
    const aspect = 16 / 9;
    /** Largest change in slope between neighbouring columns of the nearest ridge. */
    const kink = (softness: number) => {
      const t = new Float32Array(tableSize);
      fillRidgeTable(t, 4, aspect, 7, createTableScratch(), softness);
      let max = 0;
      for (let j = 1; j < TABLE_COLUMNS; j++) {
        const a = t[(j - 1) * TABLE_CHANNELS + 1];
        const b = t[j * TABLE_CHANNELS + 1];
        max = Math.max(max, Math.abs(b - a));
      }
      for (let i = 0; i < 4; i++) {
        const shape = ridgeShape(i, 4);
        for (let j = 0; j < TABLE_COLUMNS; j += 5) {
          const h = heightAt(t, i, j, 4);
          expect(h).toBeGreaterThanOrEqual(shape.base - 1e-6);
          expect(h).toBeLessThanOrEqual(shape.base + shape.amp + 1e-6);
        }
      }
      return max;
    };
    const two = kink(2);
    const top = kink(MAX_CREST_SOFTNESS);
    expect(top).toBeLessThan(two * 0.8);
    expect(kink(0)).toBeGreaterThan(two);
  });
});

describe("horizonAngles", () => {
  /** Brute-force reference: highest elevation angle to any sample on each side. */
  function reference(h: Float64Array, dx: number) {
    const n = h.length;
    const left = new Float64Array(n).fill(-Math.PI / 2);
    const right = new Float64Array(n).fill(-Math.PI / 2);
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        if (k === j) {
          continue;
        }
        const a = Math.atan2(h[k] - h[j], Math.abs(k - j) * dx);
        if (k < j) {
          left[j] = Math.max(left[j], a);
        } else {
          right[j] = Math.max(right[j], a);
        }
      }
    }
    return { left, right };
  }

  it("matches a brute-force search", () => {
    const n = 300;
    const h = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      h[i] = 0.1 * Math.sin(i * 0.07) + 0.05 * Math.sin(i * 0.31 + 1) + 0.02 * ((i * 37) % 11);
    }
    const left = new Float64Array(n);
    const right = new Float64Array(n);
    horizonAngles(h, 0.01, left, right, new Int32Array(n));
    const ref = reference(h, 0.01);
    for (let i = 0; i < n; i++) {
      expect(left[i]).toBeCloseTo(ref.left[i], 12);
      expect(right[i]).toBeCloseTo(ref.right[i], 12);
    }
  });

  it("shadows the lee side of a dune for a low sun behind the crest", () => {
    const aspect = 16 / 9;
    const t = buildTable(3, aspect, 1);
    // Some columns of the near ridge see a left horizon above 17 degrees (in shadow
    // for a low sun from the left), and some are open below 6 degrees.
    let shadowed = 0;
    let open = 0;
    for (let j = 0; j < TABLE_COLUMNS; j++) {
      const hz = t[j * TABLE_CHANNELS + 2];
      if (hz > 0.3) {
        shadowed++;
      }
      if (hz < 0.1) {
        open++;
      }
    }
    expect(shadowed).toBeGreaterThan(20);
    expect(open).toBeGreaterThan(20);
  });
});

describe("fillLayout", () => {
  it("hazes distant ridges and puts ripples on the near ones only", () => {
    const out = new Float32Array(MAX_RIDGES * LAYOUT_FLOATS);
    for (let count = MIN_RIDGES; count <= MAX_RIDGES; count++) {
      fillLayout(out, count, 1);
      expect(out[2]).toBe(0);
      expect(out[3]).toBeGreaterThan(0);
      for (let i = 1; i < count; i++) {
        const o = i * LAYOUT_FLOATS;
        expect(out[o]).toBeGreaterThan(out[o - LAYOUT_FLOATS]);
        expect(out[o + 1]).toBeGreaterThan(0);
        expect(out[o + 2]).toBeGreaterThan(out[o + 2 - LAYOUT_FLOATS]);
      }
      for (let i = 2; i < count; i++) {
        expect(out[i * LAYOUT_FLOATS + 3]).toBe(0);
      }
      expect(out.subarray(count * LAYOUT_FLOATS).every((v) => v === 0)).toBe(true);
      fillLayout(out, count, 0);
      for (let i = 0; i < count; i++) {
        expect(out[i * LAYOUT_FLOATS + 3]).toBe(0);
      }
    }
  });
});

describe("sun path", () => {
  const pos: SunPosition = { elevation: 0, azimuth: 0 };

  it("stays between golden hour and midday, on the left", () => {
    for (let k = 0; k <= 1000; k++) {
      sunAt(k / 1000, pos);
      expect(pos.elevation).toBeGreaterThanOrEqual(SUN_ELEVATION_MIN - 1e-12);
      expect(pos.elevation).toBeLessThanOrEqual(SUN_ELEVATION_MAX + 1e-12);
      expect(pos.azimuth).toBeGreaterThan(SUN_AZIMUTH_LOW - 0.07);
      expect(pos.azimuth).toBeLessThan(SUN_AZIMUTH_HIGH + 0.07);
      expect(pos.azimuth).toBeLessThan(0);
    }
  });

  it("is continuous through its cycle, including the wrap", () => {
    const step = 1e-3;
    let prevE = sunAt(-step, pos).elevation;
    let prevA = pos.azimuth;
    for (let k = 0; k <= 1000; k++) {
      sunAt(k * step, pos);
      expect(Math.abs(pos.elevation - prevE)).toBeLessThan(0.01);
      expect(Math.abs(pos.azimuth - prevA)).toBeLessThan(0.01);
      prevE = pos.elevation;
      prevA = pos.azimuth;
    }
    const a = { ...sunAt(0, pos) };
    expect(sunAt(1, pos).elevation).toBeCloseTo(a.elevation, 12);
    expect(sunAt(1, pos).azimuth).toBeCloseTo(a.azimuth, 12);
  });

  it("starts at the requested height", () => {
    for (const hgt of [0, 0.25, 0.5, 1]) {
      sunAt(startPhase(hgt), pos);
      const expected = SUN_ELEVATION_MIN + (SUN_ELEVATION_MAX - SUN_ELEVATION_MIN) * hgt;
      expect(pos.elevation).toBeCloseTo(expected, 9);
    }
  });
});
