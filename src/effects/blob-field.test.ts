import { describe, expect, it } from "vitest";
import { BLOB_PATHS, blobAt, makeBlobPaths, writeBlobUniforms } from "./blob-field";
import { MAX_BLOBS } from "./blobs/blobs.meta";

describe("blob paths", () => {
  it("are deterministic", () => {
    expect(makeBlobPaths()).toEqual(BLOB_PATHS);
    expect(BLOB_PATHS).toHaveLength(MAX_BLOBS);
  });

  it("stay near the frame with radius 30-60% of height (x1.15 breathing)", () => {
    const out = [0, 0, 0];
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const path of BLOB_PATHS) {
      for (let t = 0; t < 600; t += 0.37) {
        blobAt(path, t, 16 / 9, 1, out);
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], out[k]);
          hi[k] = Math.max(hi[k], out[k]);
        }
      }
    }
    expect(lo[0]).toBeGreaterThanOrEqual(0);
    expect(hi[0]).toBeLessThanOrEqual(16 / 9);
    expect(lo[1]).toBeGreaterThanOrEqual(0);
    expect(hi[1]).toBeLessThanOrEqual(1);
    expect(lo[2]).toBeGreaterThanOrEqual(0.3 * 0.85 - 1e-9);
    expect(hi[2]).toBeLessThanOrEqual(0.6 * 1.15 + 1e-9);
  });

  it("move slowly: under 0.6 frame heights per second at speed 1", () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    const dt = 0.01;
    for (const path of BLOB_PATHS) {
      for (let t = 0; t < 120; t += 0.5) {
        blobAt(path, t, 16 / 9, 1, a);
        blobAt(path, t + dt, 16 / 9, 1, b);
        expect(Math.hypot(b[0] - a[0], b[1] - a[1]) / dt).toBeLessThan(0.6);
      }
    }
  });

  it("have main loop periods of tens of seconds at the default speed (0.3)", () => {
    for (const p of BLOB_PATHS) {
      for (const w of [p.wx, p.wy]) {
        const period = (2 * Math.PI) / (w * 0.3);
        expect(period).toBeGreaterThan(25);
        expect(period).toBeLessThan(60);
      }
    }
  });

  it("scale radius by softness", () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    blobAt(BLOB_PATHS[0], 3, 1, 1, a);
    blobAt(BLOB_PATHS[0], 3, 1, 1.5, b);
    expect(b[2]).toBeCloseTo(a[2] * 1.5, 6);
  });
});

describe("writeBlobUniforms", () => {
  it("writes Gaussian exponents for the first count blobs only", () => {
    const out = new Float32Array(MAX_BLOBS * 4).fill(9);
    writeBlobUniforms(out, 3, 2, 1.5, 1);
    const xyr = [0, 0, 0];
    blobAt(BLOB_PATHS[1], 2, 1.5, 1, xyr);
    expect(out[4]).toBeCloseTo(xyr[0], 5);
    expect(out[5]).toBeCloseTo(xyr[1], 5);
    // exp2(-r² k) = 1/e at one radius.
    expect(2 ** (-xyr[2] * xyr[2] * out[6])).toBeCloseTo(Math.exp(-1), 5);
    expect(out[7]).toBe(1);
    // The shader stops at uCount, so later slots are left alone.
    for (let i = 3 * 4; i < out.length; i++) {
      expect(out[i]).toBe(9);
    }
  });

  it("writes each blob's fade weight", () => {
    const out = new Float32Array(MAX_BLOBS * 4);
    writeBlobUniforms(out, 2, 0, 1, 1, [1, 0.25]);
    expect(out[3]).toBe(1);
    expect(out[7]).toBe(0.25);
  });
});
