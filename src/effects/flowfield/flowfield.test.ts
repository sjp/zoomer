import { describe, expect, it } from "vitest";
import { fadeTerms } from "./flowfield";
import { hash32 } from "../noise";

/**
 * One pixel of FADE_FRAGMENT in float32, as the GPU runs it: the fade as a
 * multiply-add in target levels, stochastically rounded with the hash's top 24 bits.
 */
function fadePixel(v: number, terms: Float64Array, levels: number, seed: number): number {
  const f = Math.fround;
  const r = f((hash32(seed) >>> 8) * (1 / 16777216));
  const x = f(terms[0]);
  const y = f(terms[1]);
  const stepped = Math.floor(f(f(f(v * x) + y) + r)) * f(1 / levels);
  return Math.max(f(stepped), 0);
}

describe("flowfield trail fade", () => {
  const terms = new Float64Array(2);

  it.each([255, 1023])("fades a full %i-level pixel to exactly empty", (levels) => {
    for (const dt of [1 / 240, 1 / 120, 1 / 60, 0.1]) {
      // The slowest trail is the hardest case: its exponential fade alone would stall.
      for (const trail of [0, 0.5, 1]) {
        fadeTerms(dt, trail, levels, terms);
        let v = 1;
        let frames = 0;
        let frameNo = 0;
        // Six time constants of decay plus a minute of the clean pull, generously.
        const limit = Math.ceil((60 + 6 * 0.1 * 30 ** trail) / dt);
        while (v > 0 && frames < limit) {
          const next = fadePixel(v, terms, levels, (frameNo = (frameNo + 1) >>> 0) * 7919);
          expect(next).toBeLessThanOrEqual(v);
          expect(next).toBeGreaterThanOrEqual(0);
          v = next;
          frames++;
        }
        expect(v).toBe(0);
      }
    }
  });

  it("keeps an empty pixel empty and leaves the layer alone when paused", () => {
    for (const levels of [255, 1023]) {
      fadeTerms(1 / 60, 1, levels, terms);
      for (let seed = 0; seed < 1000; seed++) {
        expect(fadePixel(0, terms, levels, seed)).toBe(0);
      }
      fadeTerms(0, 1, levels, terms);
      for (let level = 0; level <= levels; level += 31) {
        expect(fadePixel(level / levels, terms, levels, level)).toBeCloseTo(level / levels, 6);
      }
    }
  });

  it("fades at the exponential's average rate, not stalling on rounding", () => {
    // From mid-grey, the expected level after a second with trail 1 (tau = 3s) is
    // set by keep and clean; stochastic rounding should land close on average.
    const levels = 255;
    const dt = 1 / 60;
    fadeTerms(dt, 1, levels, terms);
    let sum = 0;
    const pixels = 2000;
    for (let p = 0; p < pixels; p++) {
      let v = 0.5;
      for (let frame = 0; frame < 60; frame++) {
        v = fadePixel(v, terms, levels, p * 65537 + frame);
      }
      sum += v;
    }
    let expected = 0.5;
    const keep = Math.exp(-dt / 3);
    const clean = dt * (20 / 255);
    for (let frame = 0; frame < 60; frame++) {
      expected = expected * keep - clean * (1 - expected);
    }
    expect(sum / pixels).toBeCloseTo(expected, 2);
  });
});
