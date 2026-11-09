import { describe, expect, it } from "vitest";
import { CLOUD_TOPS_GLSL, driftTops, OCTAVES } from "./cloudsea-tops";

/** Octave k's matrix as the shader declares it: GLSL mat2 columns (a, b), (c, d). */
function shaderMatrix(k: number): [number, number, number, number] {
  const m = new RegExp(`const mat2 M${String(k)} = mat2\\(([^)]*)\\);`).exec(CLOUD_TOPS_GLSL);
  const v = (m?.[1] ?? "").split(",").map(Number);
  expect(v).toHaveLength(4);
  return [v[0], v[1], v[2], v[3]];
}

/** Distance between two tile coordinates, allowing for the wrap. */
const wrapped = (a: number, b: number) => {
  const d = a - b;
  return Math.abs(d - Math.round(d));
};

describe("driftTops", () => {
  it("keeps every offset in [0, 1)", () => {
    const off = new Float64Array(6);
    for (let i = 0; i < 500; i++) {
      driftTops(off, 3.7 * Math.sin(i), -11.3 * Math.cos(i * 0.7));
      for (const v of off) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it("moves every octave as if sampled at w + (vx, vz), using the shader's matrices", () => {
    expect(OCTAVES).toHaveLength(3);
    const vx = 0.37;
    const vz = -0.21;
    const off = new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const before = Array.from(off);
    driftTops(off, vx, vz);
    for (let k = 0; k < 3; k++) {
      // uv = M w + off, so a sample at w + v is M w + (off + M v).
      const [a, b, c, d] = shaderMatrix(k);
      expect(wrapped(off[2 * k], before[2 * k] + a * vx + c * vz)).toBeLessThan(1e-6);
      expect(wrapped(off[2 * k + 1], before[2 * k + 1] + b * vx + d * vz)).toBeLessThan(1e-6);
    }
  });

  it("gives the same offsets for many small steps as one long one", () => {
    const steps = new Float64Array(6);
    for (let i = 0; i < 1000; i++) {
      driftTops(steps, 0.013, 0.021);
    }
    const once = new Float64Array(6);
    driftTops(once, 13, 21);
    for (let i = 0; i < 6; i++) {
      expect(wrapped(steps[i], once[i])).toBeLessThan(1e-9);
    }
  });

  it("drifts back to where it started", () => {
    const off = new Float64Array([0.9, 0.05, 0.5, 0.999, 0, 0.25]);
    const start = Array.from(off);
    driftTops(off, 5.5, -2.25);
    driftTops(off, -5.5, 2.25);
    for (let i = 0; i < 6; i++) {
      expect(wrapped(off[i], start[i])).toBeLessThan(1e-12);
    }
  });
});
