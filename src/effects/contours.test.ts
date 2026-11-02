import { describe, expect, it } from "vitest";
import {
  advanceZ,
  bsplineTaps,
  bsplineWeights,
  fieldDivisor,
  fillT,
  isIndexLevel,
  lineStyle,
  packHeight8,
  unpackHeight8,
  Z_PERIOD,
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

/** GLSL `mod`: `x - y * floor(x / y)`. */
const mod = (x: number, y: number) => x - y * Math.floor(x / y);
const permute = (x: number) => mod((x * 34 + 10) * x, 289);
const step = (edge: number, x: number) => (x < edge ? 0 : 1);

/**
 * CPU port of the shader's `snoise` (Ashima Arts / Gustavson, r^2 = 0.5 kernel),
 * statement for statement, in float64.
 */
function snoise(vx: number, vy: number, vz: number): number {
  const C0 = 1 / 6;
  const C1 = 1 / 3;
  const sk = (vx + vy + vz) * C1;
  let ix = Math.floor(vx + sk);
  let iy = Math.floor(vy + sk);
  let iz = Math.floor(vz + sk);
  const un = (ix + iy + iz) * C0;
  const x0 = [vx - ix + un, vy - iy + un, vz - iz + un];
  // g = step(x0.yzx, x0.xyz); l = 1 - g.
  const g = [step(x0[1], x0[0]), step(x0[2], x0[1]), step(x0[0], x0[2])];
  const l = [1 - g[0], 1 - g[1], 1 - g[2]];
  // i1 = min(g.xyz, l.zxy); i2 = max(g.xyz, l.zxy).
  const i1 = [Math.min(g[0], l[2]), Math.min(g[1], l[0]), Math.min(g[2], l[1])];
  const i2 = [Math.max(g[0], l[2]), Math.max(g[1], l[0]), Math.max(g[2], l[1])];
  const xs = [
    x0,
    [0, 1, 2].map((k) => x0[k] - i1[k] + C0),
    [0, 1, 2].map((k) => x0[k] - i2[k] + C1),
    [0, 1, 2].map((k) => x0[k] - 0.5),
  ];
  ix = mod(ix, 289);
  iy = mod(iy, 289);
  iz = mod(iz, 289);
  const oz = [0, i1[2], i2[2], 1];
  const oy = [0, i1[1], i2[1], 1];
  const ox = [0, i1[0], i2[0], 1];
  let sum = 0;
  for (let c = 0; c < 4; c++) {
    const pp = permute(permute(permute(iz + oz[c]) + iy + oy[c]) + ix + ox[c]);
    // ns = n_ * D.wyz - D.xzx = (2/7, 0.5/7 - 1, 1/7).
    const nsx = 2 / 7;
    const nsy = 0.5 / 7 - 1;
    const nsz = 1 / 7;
    const j = pp - 49 * Math.floor(pp * nsz * nsz);
    const xq = Math.floor(j * nsz);
    const yq = Math.floor(j - 7 * xq);
    const x = xq * nsx + nsy;
    const y = yq * nsx + nsy;
    const h = 1 - Math.abs(x) - Math.abs(y);
    // a = b.xy + s.xy * sh, with s = floor(b) * 2 + 1 and sh = -step(h, 0).
    const sh = -step(h, 0);
    const ax = x + (Math.floor(x) * 2 + 1) * sh;
    const ay = y + (Math.floor(y) * 2 + 1) * sh;
    const len = Math.hypot(ax, ay, h);
    const p = xs[c];
    const d2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
    let m = Math.max(0.5 - d2, 0);
    m *= m;
    sum += m * m * ((ax * p[0] + ay * p[1] + h * p[2]) / len);
  }
  return 105 * sum;
}

/** The shader's three-octave height before the soft clip. */
const height = (x: number, y: number, z: number) =>
  (snoise(x, y, z) +
    0.45 * snoise(x * 2.03 + 19.19, y * 2.03 - 7.31, z + 31.7) +
    0.2 * snoise(x * 4.11 - 3.77, y * 4.11 + 11.13, z + 57.3)) /
  1.65;

describe("noise z wrapping", () => {
  // Deterministic sample points, including negative coordinates and lattice edges.
  const points: [number, number, number][] = [];
  for (let k = 0; k < 400; k++) {
    points.push([
      ((k * 0.7548777) % 1) * 40 - 20,
      ((k * 0.5698403) % 1) * 40 - 20,
      ((k * 0.3141593) % 1) * 30 - 15,
    ]);
  }
  points.push([0, 0, 0], [1, 1, 1], [-2.5, 3.25, 0.5]);

  it("port returns varied values in the noise's range", () => {
    let min = Infinity;
    let max = -Infinity;
    for (const [x, y, z] of points) {
      const n = snoise(x, y, z);
      min = Math.min(min, n);
      max = Math.max(max, n);
    }
    expect(min).toBeLessThan(-0.4);
    expect(max).toBeGreaterThan(0.4);
    expect(min).toBeGreaterThanOrEqual(-1.2);
    expect(max).toBeLessThanOrEqual(1.2);
  });

  it("the noise and the full height repeat exactly every Z_PERIOD in z", () => {
    for (const [x, y, z] of points) {
      for (const shift of [Z_PERIOD, -Z_PERIOD, 5 * Z_PERIOD]) {
        expect(snoise(x, y, z + shift)).toBeCloseTo(snoise(x, y, z), 9);
        expect(height(x, y, z + shift)).toBeCloseTo(height(x, y, z), 9);
      }
    }
  });

  it("does not repeat at shorter candidate periods", () => {
    for (const shift of [289, 3, 2 * 289]) {
      let maxDiff = 0;
      for (const [x, y, z] of points) {
        maxDiff = Math.max(maxDiff, Math.abs(snoise(x, y, z + shift) - snoise(x, y, z)));
      }
      expect(maxDiff).toBeGreaterThan(0.1);
    }
  });

  it("advanceZ keeps z within half a period and moves by dz modulo the period", () => {
    let z = 0;
    let unwrapped = 0;
    const dz = 0.37;
    for (let k = 0; k < 10000; k++) {
      z = advanceZ(z, dz);
      unwrapped += dz;
      expect(z).toBeGreaterThanOrEqual(-Z_PERIOD / 2);
      expect(z).toBeLessThan(Z_PERIOD / 2);
      const offset = (unwrapped - z) / Z_PERIOD;
      expect(Math.abs(offset - Math.round(offset))).toBeLessThan(1e-9);
    }
    expect(advanceZ(1, 0.5)).toBe(1.5);
  });
});
