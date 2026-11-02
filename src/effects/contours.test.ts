import { describe, expect, it } from "vitest";
import {
  bsplineTaps,
  bsplineWeights,
  fieldDivisor,
  fillT,
  isIndexLevel,
  lineStyle,
  packHeight8,
  unpackHeight8,
} from "./contours";

/** Linear interpolation of `data` at fractional index `x` (clamped), like a bilinear fetch. */
const lerpAt = (data: number[], x: number) => {
  const i = Math.max(0, Math.min(data.length - 2, Math.floor(x)));
  const t = x - i;
  return data[i] * (1 - t) + data[i + 1] * t;
};

/** Direct 4-tap B-spline at texel i + t. */
const bspline = (data: number[], i: number, t: number) => {
  const w = bsplineWeights(t);
  return w[0] * data[i - 1] + w[1] * data[i] + w[2] * data[i + 1] + w[3] * data[i + 2];
};

/** The 2-tap form used by the shader. */
const bspline2 = (data: number[], i: number, t: number) => {
  const { g0, g1, o0, o1 } = bsplineTaps(t);
  return g0 * lerpAt(data, i - 1 + o0) + g1 * lerpAt(data, i + 1 + o1);
};

const DATA = [0.3, 0.1, 0.7, 0.4, 0.9, 0.2, 0.5, 0.8];

describe("B-spline sampling", () => {
  it("weights sum to 1 and are non-negative", () => {
    for (let t = 0; t <= 1; t += 0.125) {
      const w = bsplineWeights(t);
      expect(w[0] + w[1] + w[2] + w[3]).toBeCloseTo(1, 12);
      for (const x of w) expect(x).toBeGreaterThanOrEqual(0);
    }
  });

  it("two linear taps reproduce the four-tap filter", () => {
    for (let i = 1; i < DATA.length - 2; i++) {
      for (let t = 0; t < 1; t += 0.1) {
        expect(bspline2(DATA, i, t)).toBeCloseTo(bspline(DATA, i, t), 12);
      }
    }
  });

  it("keeps tap offsets inside their texel pairs", () => {
    for (let t = 0; t <= 1; t += 0.05) {
      const { o0, o1 } = bsplineTaps(t);
      expect(o0).toBeGreaterThanOrEqual(0);
      expect(o0).toBeLessThanOrEqual(1);
      expect(o1).toBeGreaterThanOrEqual(0);
      expect(o1).toBeLessThanOrEqual(1);
    }
  });

  it("is C1 across texel boundaries, unlike bilinear", () => {
    const e = 1e-5;
    const i = 3;
    const slope = (fn: (x: number) => number, x: number) => (fn(x + e) - fn(x - e)) / (2 * e);
    const bs = (x: number) => bspline(DATA, Math.floor(x), x - Math.floor(x));
    // Slopes just left and right of texel 4.
    const left = slope(bs, i + 1 - 4 * e);
    const right = slope(bs, i + 1 + 4 * e);
    expect(Math.abs(left - right)).toBeLessThan(1e-3);
    const bl = (x: number) => lerpAt(DATA, x);
    expect(Math.abs(slope(bl, i + 1 - 4 * e) - slope(bl, i + 1 + 4 * e))).toBeGreaterThan(0.1);
  });
});

describe("8-bit height packing", () => {
  it("round-trips to 16-bit precision", () => {
    for (let h = 0; h < 1; h += 0.0123) {
      const [hi, lo] = packHeight8(h);
      expect(hi).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(255);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(lo).toBeLessThanOrEqual(255);
      expect(Math.abs(unpackHeight8(hi, lo) - h)).toBeLessThanOrEqual(0.5 / (255 * 255) + 1e-12);
    }
  });

  it("decodes linearly, so filtering the bytes filters the height", () => {
    const a = 0.4987;
    const b = 0.5031;
    const [ahi, alo] = packHeight8(a);
    const [bhi, blo] = packHeight8(b);
    for (let t = 0; t <= 1; t += 0.25) {
      const mixed = unpackHeight8(ahi + (bhi - ahi) * t, alo + (blo - alo) * t);
      expect(mixed).toBeCloseTo(a + (b - a) * t, 4);
    }
  });
});

describe("isIndexLevel", () => {
  it("marks every Nth level", () => {
    const every5 = [0, 1, 2, 3, 4, 5, 6, 10, 15].map((k) => isIndexLevel(k, 5));
    expect(every5).toEqual([true, false, false, false, false, true, false, true, true]);
    for (let k = 0; k <= 60; k++) expect(isIndexLevel(k, 6)).toBe(k % 6 === 0);
    for (let k = 0; k <= 60; k++) expect(isIndexLevel(k, 7)).toBe(k % 7 === 0);
  });

  it("is off for 0", () => {
    expect(isIndexLevel(0, 0)).toBe(false);
    expect(isIndexLevel(10, 0)).toBe(false);
  });
});

describe("fillT", () => {
  it("is 0 with no fill", () => {
    expect(fillT(0.7, 10, "none")).toBe(0);
  });

  it("follows height when smooth", () => {
    expect(fillT(0.25, 10, "smooth")).toBe(0.25);
    expect(fillT(1.5, 10, "smooth")).toBe(1);
  });

  it("uses each band's mid-height", () => {
    expect(fillT(0.01, 4, "bands")).toBe(0.125);
    expect(fillT(0.26, 4, "bands")).toBe(0.375);
    expect(fillT(0.74, 4, "bands")).toBe(0.625);
    expect(fillT(0.999, 4, "bands")).toBe(0.875);
    expect(fillT(1, 4, "bands")).toBe(0.875);
  });
});

describe("lineStyle", () => {
  it("scales width with the viewport", () => {
    const s = lineStyle(2, 2);
    expect(s.halfWidth).toBe(2);
    expect(s.indexHalfWidth).toBeCloseTo(3.6);
    expect(s.indexAlpha).toBe(1);
  });

  it("fades sub-pixel lines instead of thinning them", () => {
    const s = lineStyle(0.5, 1);
    expect(s.halfWidth).toBe(0.5);
    expect(s.alpha).toBeCloseTo(0.35);
    expect(s.crowdStart).toBeLessThan(s.crowdEnd);
  });
});

describe("fieldDivisor", () => {
  it("keeps the field at 270 rows", () => {
    expect(fieldDivisor(1080)).toBe(4);
    expect(fieldDivisor(2160)).toBe(8);
    expect(fieldDivisor(100)).toBe(1);
  });
});
