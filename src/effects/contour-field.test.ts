import { describe, expect, it } from "vitest";
import {
  BSPLINE_BASIS,
  BSPLINE_GLSL,
  BSPLINE_TAP_BASE,
  bsplineTaps,
  bsplineWeights,
  decodeHeight,
  ENCODE_HEIGHT_GLSL,
  heightDecodeScale,
  HEIGHT_BYTE,
  packHeight8,
  RESIDUAL_SCALE,
} from "./contour-field";
import { glslFloat } from "./gl";

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

/** The 2-tap form the shader uses, with its tap offsets. */
const bspline2 = (data: number[], i: number, t: number) => {
  const { g0, g1, o0, o1 } = bsplineTaps(t);
  return (
    g0 * lerpAt(data, i + BSPLINE_TAP_BASE[0] + o0) +
    g1 * lerpAt(data, i + BSPLINE_TAP_BASE[1] + o1)
  );
};

const DATA = [0.3, 0.1, 0.7, 0.4, 0.9, 0.2, 0.5, 0.8];

describe("B-spline sampling", () => {
  it("has the cubic B-spline basis", () => {
    // The textbook form, evaluated directly.
    for (let t = 0; t <= 1; t += 0.125) {
      const w = bsplineWeights(t);
      expect(w[0]).toBeCloseTo((1 - t) ** 3 / 6, 12);
      expect(w[1]).toBeCloseTo((3 * t ** 3 - 6 * t ** 2 + 4) / 6, 12);
      expect(w[2]).toBeCloseTo((-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6, 12);
      expect(w[3]).toBeCloseTo(t ** 3 / 6, 12);
    }
  });

  it("generates the shader's weights and tap centres from the tested basis", () => {
    for (const k of [0, 1, 3]) {
      const c = BSPLINE_BASIS[k].map(glslFloat);
      expect(BSPLINE_GLSL).toContain(
        `vec2 w${String(k)} = ${c[0]} + ${c[1]} * t + ${c[2]} * t2 + ${c[3]} * t3;`,
      );
    }
    // The shader drops w2 (g1 = 1 - g0), which needs the weights to sum to 1.
    for (let p = 0; p < 4; p++) {
      expect(BSPLINE_BASIS.reduce((sum, row) => sum + row[p], 0)).toBeCloseTo(p === 0 ? 1 : 0, 12);
    }
    expect(BSPLINE_GLSL).toContain(`(i + ${glslFloat(BSPLINE_TAP_BASE[0] + 0.5)} + w1 / g0)`);
    expect(BSPLINE_GLSL).toContain(`(i + ${glslFloat(BSPLINE_TAP_BASE[1] + 0.5)} + w3 / g1)`);
  });

  it("weights sum to 1 and are non-negative", () => {
    for (let t = 0; t <= 1; t += 0.125) {
      const w = bsplineWeights(t);
      expect(w[0] + w[1] + w[2] + w[3]).toBeCloseTo(1, 12);
      for (const x of w) {
        expect(x).toBeGreaterThanOrEqual(0);
      }
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

describe("height encoding", () => {
  /** The 8-bit bytes as the shader samples them, decoded with the uploaded scale. */
  const decode8 = (hi: number, lo: number) =>
    decodeHeight(hi / HEIGHT_BYTE, lo / HEIGHT_BYTE, heightDecodeScale(false));

  it("round-trips the 8-bit encoding to 16-bit precision", () => {
    expect(ENCODE_HEIGHT_GLSL).toContain(`float s = h * ${glslFloat(HEIGHT_BYTE)};`);
    for (let h = 0; h < 1; h += 0.0123) {
      const [hi, lo] = packHeight8(h);
      expect(hi).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(255);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(lo).toBeLessThanOrEqual(255);
      expect(Math.abs(decode8(hi, lo) - h)).toBeLessThanOrEqual(0.5 / (255 * 255) + 1e-12);
    }
  });

  it("decodes linearly, so filtering the bytes filters the height", () => {
    const a = 0.4987;
    const b = 0.5031;
    const [ahi, alo] = packHeight8(a);
    const [bhi, blo] = packHeight8(b);
    for (let t = 0; t <= 1; t += 0.25) {
      const mixed = decode8(ahi + (bhi - ahi) * t, alo + (blo - alo) * t);
      expect(mixed).toBeCloseTo(a + (b - a) * t, 4);
    }
  });

  it("restores the half-float rounding residual", () => {
    expect(ENCODE_HEIGHT_GLSL).toContain(`(h - hr) * ${glslFloat(RESIDUAL_SCALE)}`);
    for (let h = 0; h < 1; h += 0.0371) {
      // Any rounding of h will do: the residual channel carries the rest.
      const hr = Math.round(h * 2048) / 2048;
      const g = (h - hr) * RESIDUAL_SCALE;
      expect(decodeHeight(hr, g, heightDecodeScale(true))).toBeCloseTo(h, 12);
    }
  });
});
