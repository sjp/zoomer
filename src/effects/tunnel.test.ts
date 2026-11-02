import { describe, expect, it } from "vitest";
import { buildMipChain, buildTexture, downsample2x, TEX, wrapTexels } from "./tunnel";

describe("downsample2x", () => {
  it("box-filters each 2x2 block", () => {
    const src = new Float32Array([1, 3, 0, 0, 5, 7, 4, 8, 2, 2, 1, 1, 2, 2, 1, 1]);
    expect(Array.from(downsample2x(src, 4))).toEqual([4, 3, 2, 1]);
  });

  it("keeps a 1x1 texture", () => {
    expect(Array.from(downsample2x(new Float32Array([0.25]), 1))).toEqual([0.25]);
  });
});

describe("buildMipChain", () => {
  it("halves down to 1x1 and preserves the mean", () => {
    const size = 16;
    const data = new Float32Array(size * size);
    for (let i = 0; i < data.length; i++) data[i] = ((i * 37) % 11) / 10;
    const levels = buildMipChain(data, size);
    expect(levels.map((l) => l.length)).toEqual([256, 64, 16, 4, 1]);
    expect(levels[0]).toBe(data);
    const mean = data.reduce((a, b) => a + b, 0) / data.length;
    expect(levels[4][0]).toBeCloseTo(mean, 5);
  });
});

describe("wrapTexels", () => {
  it("wraps negative and large offsets into [0, TEX)", () => {
    expect(wrapTexels(-1)).toBe(TEX - 1);
    expect(wrapTexels(-TEX - 0.25)).toBe(TEX - 0.25);
    expect(wrapTexels(TEX * 3 + 2)).toBe(2);
    expect(wrapTexels(5.5)).toBe(5.5);
    for (const x of [-1e-12, -1e-17, -TEX, -3 * TEX + 1e-9]) {
      const w = wrapTexels(x);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(TEX);
    }
  });
});

describe("buildTexture", () => {
  const tex = new Float32Array(TEX * TEX);
  buildTexture(tex, 1337);
  const at = (x: number, y: number) => tex[(y & (TEX - 1)) * TEX + (x & (TEX - 1))];

  it("is deterministic and stays within [0, 1]", () => {
    const again = new Float32Array(TEX * TEX);
    buildTexture(again, 1337);
    expect(again).toEqual(tex);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of tex) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    // Equalised, so it spans nearly all of it.
    expect(lo).toBeLessThan(0.05);
    expect(hi).toBeGreaterThan(0.9);
  });

  it("tiles: steps across both seams are like steps inside", () => {
    let inner = 0;
    let seam = 0;
    for (let i = 0; i < TEX; i++) {
      for (let j = 1; j < TEX; j++) {
        inner += Math.abs(at(j, i) - at(j - 1, i)) + Math.abs(at(i, j) - at(i, j - 1));
      }
      seam += Math.abs(at(0, i) - at(TEX - 1, i)) + Math.abs(at(i, 0) - at(i, TEX - 1));
    }
    const innerMean = inner / (2 * TEX * (TEX - 1));
    const seamMean = seam / (2 * TEX);
    expect(seamMean).toBeLessThan(innerMean * 1.3);
    expect(seamMean).toBeGreaterThan(innerMean * 0.7);
  });

  it("follows the t^1.5 histogram it is shaped to, so bright strands stay a minority", () => {
    // Before the light blur, value v has CDF v^(2/3); the blur only nudges it.
    const n = tex.length;
    const mean = tex.reduce((a, b) => a + b, 0) / n;
    expect(mean).toBeCloseTo(0.4, 1);
    for (const v of [0.1, 0.25, 0.5, 0.75]) {
      const below = tex.filter((x) => x < v).length / n;
      expect(Math.abs(below - v ** (2 / 3))).toBeLessThan(0.05);
    }
  });
});
