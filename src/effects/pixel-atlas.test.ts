import { describe, expect, it } from "vitest";
import { luma, packPixelAtlas } from "./pixel-atlas";

describe("packPixelAtlas", () => {
  const palette = ["#000000", "#ffffff", "#ff0000"];

  it("packs cells in rows with padding, wrapping at the width", () => {
    const atlas = packPixelAtlas([["11", "11"], ["1"], ["111"]], palette, 8, 1);
    expect(atlas.cells.map(({ x, y, w, h }) => [x, y, w, h])).toEqual([
      [1, 1, 2, 2],
      [4, 1, 1, 1],
      [1, 4, 3, 1],
    ]);
    expect(atlas.height).toBe(6);
    expect(atlas.pixels.length).toBe(8 * 6 * 4);
  });

  it("paints palette digits opaque and anything else transparent", () => {
    const atlas = packPixelAtlas([["2.9"]], palette, 4, 0);
    expect(Array.from(atlas.pixels.subarray(0, 12))).toEqual([
      255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("measures each cell's mean luminance over its whole rect", () => {
    const atlas = packPixelAtlas([["1.", ".."], ["2"]], palette, 8, 0);
    expect(atlas.cells[0].lum).toBeCloseTo(0.25);
    expect(atlas.cells[1].lum).toBeCloseTo(luma(255, 0, 0));
  });
});
