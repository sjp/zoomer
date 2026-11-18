import { describe, expect, it } from "vitest";
import {
  advanceZ,
  COMPOSITE,
  fieldDivisor,
  fillT,
  fillUniform,
  indexInv,
  isIndexLevel,
  LEVEL_CENTRE,
  lineStyle,
  Z_PERIOD,
} from "./contours";
import { glslFloat } from "../gl";

describe("index contours", () => {
  it("marks every Nth level", () => {
    const every5 = [0, 1, 2, 3, 4, 5, 6, 10, 15].map((k) => isIndexLevel(k, indexInv(5)));
    expect(every5).toEqual([true, false, false, false, false, true, false, true, true]);
    for (let n = 1; n <= 10; n++) {
      for (let k = 0; k <= 60; k++) {
        expect(isIndexLevel(k, indexInv(n))).toBe(k % n === 0);
      }
    }
    // In float32, as the shader computes it, too.
    for (let n = 1; n <= 10; n++) {
      const inv = Math.fround(indexInv(n));
      for (let k = 0; k <= 60; k++) {
        const r = Math.fround(Math.fround(k + LEVEL_CENTRE) * inv);
        expect(r - Math.floor(r) < inv).toBe(k % n === 0);
      }
    }
  });

  it("is off for 0 and rounds the slider value", () => {
    expect(indexInv(0)).toBe(0);
    expect(indexInv(0.4)).toBe(0);
    expect(indexInv(4.6)).toBe(1 / 5);
    expect(isIndexLevel(0, indexInv(0))).toBe(false);
    expect(isIndexLevel(10, indexInv(0))).toBe(false);
  });

  it("is the test the shader runs", () => {
    expect(COMPOSITE).toContain(`fract((k + ${glslFloat(LEVEL_CENTRE)}) * uIndexInv) < uIndexInv`);
  });
});

describe("fillT", () => {
  it("is 0 with no fill", () => {
    expect(fillUniform("none")).toEqual([0, 0]);
    expect(fillT(0.7, 10, fillUniform("none"))).toBe(0);
  });

  it("follows height when smooth, the default", () => {
    expect(fillUniform("smooth")).toEqual([1, 0]);
    expect(fillUniform("nonsense")).toEqual([1, 0]);
    expect(fillT(0.25, 10, fillUniform("smooth"))).toBe(0.25);
    expect(fillT(1.5, 10, fillUniform("smooth"))).toBe(1);
  });

  it("uses each band's mid-height", () => {
    const bands = fillUniform("bands");
    expect(bands).toEqual([1, 1]);
    expect(fillT(0.01, 4, bands)).toBe(0.125);
    expect(fillT(0.26, 4, bands)).toBe(0.375);
    expect(fillT(0.74, 4, bands)).toBe(0.625);
    expect(fillT(0.999, 4, bands)).toBe(0.875);
    expect(COMPOSITE).toContain(
      `clamp((band + ${glslFloat(LEVEL_CENTRE)}) * uInvLevels, 0.0, 1.0)`,
    );
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
    let lo = Infinity;
    let hi = -Infinity;
    let worstOffset = 0;
    for (let k = 0; k < 10000; k++) {
      z = advanceZ(z, dz);
      unwrapped += dz;
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
      const offset = (unwrapped - z) / Z_PERIOD;
      worstOffset = Math.max(worstOffset, Math.abs(offset - Math.round(offset)));
    }
    expect(lo).toBeGreaterThanOrEqual(-Z_PERIOD / 2);
    expect(hi).toBeLessThan(Z_PERIOD / 2);
    expect(worstOffset).toBeLessThan(1e-9);
    expect(advanceZ(1, 0.5)).toBe(1.5);
  });
});
