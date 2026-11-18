import { describe, expect, it } from "vitest";
import { buildGrainTexture, GRAIN_SIZE } from "./frost-texture";

describe("buildGrainTexture", () => {
  const tex = buildGrainTexture();

  it("is deterministic RG8 data of the right size", () => {
    expect(tex.length).toBe(GRAIN_SIZE * GRAIN_SIZE * 2);
    // A plain loop: toEqual on the whole texture is slow.
    const again = buildGrainTexture();
    expect(again.length).toBe(tex.length);
    expect(again.findIndex((v, i) => v !== tex[i])).toBe(-1);
  });

  it("centres both channels on mid-grey, with fine white noise in R", () => {
    let r = 0;
    let g = 0;
    let rDiff = 0;
    let gDiff = 0;
    const n = GRAIN_SIZE * GRAIN_SIZE;
    for (let i = 0; i < n; i++) {
      r += tex[i * 2];
      g += tex[i * 2 + 1];
      if (i % GRAIN_SIZE > 0) {
        rDiff += Math.abs(tex[i * 2] - tex[i * 2 - 2]);
        gDiff += Math.abs(tex[i * 2 + 1] - tex[i * 2 - 1]);
      }
    }
    expect(r / n).toBeGreaterThan(120);
    expect(r / n).toBeLessThan(136);
    expect(g / n).toBeGreaterThan(110);
    expect(g / n).toBeLessThan(146);
    // R changes a lot from texel to texel; G (the mottling) is smooth.
    expect(rDiff / n).toBeGreaterThan(60);
    expect(gDiff / n).toBeLessThan(10);
  });
});
