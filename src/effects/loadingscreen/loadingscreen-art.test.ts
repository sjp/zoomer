import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME, pxPerReferenceFrame } from "../motion-limits";
import { ART_FOG, artLights, LIGHT_STRIDE, MAX_LIGHTS, toArtId } from "./loadingscreen-art";
import { DRIFT_REACH, MAX_ZOOM, OVERSCAN } from "./loadingscreen-sim";
import type { ArtId } from "./loadingscreen.meta";

const ARTS: ArtId[] = ["ruins", "spaceport", "forest"];

describe("key art", () => {
  it("reads the art param, falling back to the ruins", () => {
    expect(toArtId("spaceport")).toBe("spaceport");
    expect(toArtId("forest")).toBe("forest");
    expect(toArtId("nope")).toBe("ruins");
    for (const art of ARTS) {
      expect(ART_FOG[art].strength).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(ARTS)("keeps the %s lights within bounds", (art) => {
    const out = new Float32Array(MAX_LIGHTS * LIGHT_STRIDE);
    let most = 0;
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    for (let t = 0; t < 200; t += 0.7) {
      const n = artLights(art, 16 / 9, t, out);
      most = Math.max(most, n);
      for (let i = 0; i < n; i++) {
        const o = i * LIGHT_STRIDE;
        lowest = Math.min(lowest, out[o], out[o + 1], out[o + 3]);
        highest = Math.max(highest, out[o], out[o + 1], out[o + 3]);
      }
    }
    expect(most).toBeLessThanOrEqual(MAX_LIGHTS);
    expect(lowest).toBeGreaterThanOrEqual(0);
    expect(highest).toBeLessThanOrEqual(1);
  });

  it.each(ARTS.flatMap((art) => [16 / 9, 21 / 9].map((aspect) => [art, aspect] as const)))(
    "keeps the %s lights out of the middle third at aspect %f, wherever the drift is",
    (art, aspect) => {
      const out = new Float32Array(MAX_LIGHTS * LIGHT_STRIDE);
      const inMiddle: number[] = [];
      // The drift's widest swing: its window's centre at either end of its range, at either zoom.
      for (const zoom of [1, MAX_ZOOM]) {
        const size = 1 / (OVERSCAN * zoom);
        const slack = (1 - size) / 2;
        for (const reach of [-DRIFT_REACH, 0, DRIFT_REACH]) {
          const u0 = 0.5 + reach * slack - size / 2;
          for (let t = 0; t < 200; t += 0.5) {
            const n = artLights(art, aspect, t, out);
            for (let i = 0; i < n; i++) {
              const o = i * LIGHT_STRIDE;
              if (out[o + 3] < 0.05) {
                continue;
              }
              const x = (out[o] - u0) / size;
              if (!(x < 1 / 3 || x > 2 / 3)) {
                inMiddle.push(x);
              }
            }
          }
        }
      }
      expect(inMiddle).toEqual([]);
    },
  );

  it.each(ARTS)("moves and blinks the %s lights gently", (art) => {
    const a = new Float32Array(MAX_LIGHTS * LIGHT_STRIDE);
    const b = new Float32Array(MAX_LIGHTS * LIGHT_STRIDE);
    const dt = 1 / 30;
    let fastest = 0;
    let biggestBlink = 0;
    for (let t = 0; t < 200; t += 0.25) {
      const n = artLights(art, 16 / 9, t, a);
      artLights(art, 16 / 9, t + dt, b);
      for (let i = 0; i < n; i++) {
        const o = i * LIGHT_STRIDE;
        // Painting widths to frame heights: a painting is OVERSCAN frames, 16:9 wide.
        const du = (b[o] - a[o]) * OVERSCAN * (16 / 9);
        const dv = (b[o + 1] - a[o + 1]) * OVERSCAN;
        fastest = Math.max(fastest, pxPerReferenceFrame(Math.hypot(du, dv) / dt));
        biggestBlink = Math.max(biggestBlink, Math.abs(b[o + 3] - a[o + 3]));
      }
    }
    expect(fastest).toBeLessThan(MAX_FEATURE_PX_PER_FRAME);
    // At most 0.5 Hz: a full swing takes at least a second, so a frame moves under a tenth of it.
    expect(biggestBlink).toBeLessThan(0.1);
  });
});
