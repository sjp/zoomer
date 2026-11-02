import { describe, expect, it } from "vitest";
import { buildMipChain, downsample2x } from "./tunnel";

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
