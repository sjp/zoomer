import { describe, expect, it } from "vitest";
import {
  BOX_W,
  BOX_X,
  bandT,
  bandW,
  bandX,
  blindsLight,
  blindsLightBand,
  createShape,
  DIM_TINT,
  FALLOFF,
  HALF_DUTY,
  layoutShape,
  MAX_DIP,
  POSITIONS,
  stripe,
  sunColor,
  sunLevel,
  sunLevelAt,
} from "./blinds-sim";
import type { Rgb } from "../color";
import { createNoise } from "../noise";

const shape = (position = "topRight", angle = 25, slats = 10, softness = 0.35) =>
  layoutShape(createShape(), position, 1920, angle, slats, softness);

/** Band coordinates to a reference-unit point, inverting bandX / bandW. */
const toPoint = (xn: number, w: number, s = shape()) => {
  const x = s.cx + xn * s.halfW;
  return [x, s.cy + w * s.bandH + s.slope * (x - s.cx)] as const;
};

/** w at the centre of lit gap k (0-based) of a shape with `slats` stripes. */
const gapCentre = (k: number, slats: number) => (k + 0.5) / slats - 0.5;

describe("stripe", () => {
  it("is fully lit at the gap centre and dark behind the slat", () => {
    for (const pen of [0.07, 0.3, 0.5]) {
      expect(stripe(0.5, pen)).toBe(1);
      expect(stripe(3.5, pen)).toBe(1);
      expect(stripe(0, pen)).toBeLessThan(0.05);
      expect(stripe(2, pen)).toBeLessThan(0.05);
    }
    expect(stripe(0, 0.1)).toBe(0);
  });

  it("is half lit at the duty-cycle edge, whatever the penumbra", () => {
    for (const pen of [0.07, 0.3, 0.6]) {
      expect(stripe(0.5 + HALF_DUTY, pen)).toBeCloseTo(0.5, 10);
      expect(stripe(0.5 - HALF_DUTY, pen)).toBeCloseTo(0.5, 10);
    }
  });

  it("is continuous across whole periods and stays in [0, 1]", () => {
    expect(stripe(1 - 1e-9, 0.3)).toBeCloseTo(stripe(1, 0.3), 6);
    for (let n = -2; n < 2; n += 0.01) {
      const v = stripe(n, 0.3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(Math.abs(stripe(n + 0.01, 0.3) - v)).toBeLessThan(0.08);
    }
  });

  it("has a wider edge for a wider penumbra", () => {
    const edge = 0.5 + HALF_DUTY;
    expect(stripe(edge - 0.05, 0.4)).toBeLessThan(stripe(edge - 0.05, 0.1));
    expect(stripe(edge + 0.05, 0.4)).toBeGreaterThan(stripe(edge + 0.05, 0.1));
  });
});

describe("layoutShape", () => {
  it("places the footprint off-centre on the chosen side", () => {
    for (const [key, pos] of Object.entries(POSITIONS)) {
      const s = shape(key);
      expect(s.side).toBe(pos.side);
      // The speaker covers the middle third; the band centre stays outside it.
      expect(Math.abs(s.cx - 960)).toBeGreaterThan(320);
      expect(Math.sign(s.cx - 960)).toBe(pos.side);
    }
  });

  it("falls back to top right for an unknown position", () => {
    expect(shape("nowhere")).toEqual(shape("topRight"));
  });

  it("makes the stripes rise towards the window", () => {
    // y is down, so a rise to the right is a negative slope.
    expect(shape("topRight").slope).toBeCloseTo(-Math.tan((25 * Math.PI) / 180), 10);
    expect(shape("left").slope).toBeCloseTo(Math.tan((25 * Math.PI) / 180), 10);
    expect(shape("right", 0).slope).toBeCloseTo(0, 10);
  });

  it("rounds the slat count to a positive integer", () => {
    expect(shape("topRight", 25, 10.4).slats).toBe(10);
    expect(shape("topRight", 25, 0).slats).toBe(1);
  });
});

describe("band coordinates", () => {
  it("round-trip through toPoint", () => {
    const s = shape();
    for (const [xn, w] of [
      [0, 0],
      [0.7, -0.3],
      [-1, 0.5],
    ]) {
      const [x, y] = toPoint(xn, w, s);
      expect(bandX(x, s)).toBeCloseTo(xn, 10);
      expect(bandW(x, y, s)).toBeCloseTo(w, 10);
    }
  });

  it("put t = 0 at the window end and 1 at the far end", () => {
    expect(bandT(1, 1)).toBe(0);
    expect(bandT(-1, 1)).toBe(1);
    expect(bandT(-1, -1)).toBe(0);
    expect(bandT(0, 1)).toBe(0.5);
    expect(bandT(3, 1)).toBe(0);
  });
});

describe("blindsLight", () => {
  const s = shape();

  it("is bright at a stripe centre and dark between stripes", () => {
    const w = gapCentre(4, s.slats);
    // xn = 0.8 is near the window end (top right: window on the right).
    const t = bandT(0.8, s.side);
    expect(blindsLightBand(0.8, w, s)).toBeCloseTo(1 - FALLOFF * t, 10);
    expect(blindsLightBand(0.8, w + 0.5 / s.slats, s)).toBeLessThan(0.02);
  });

  it("is zero outside the window footprint", () => {
    const w = gapCentre(4, s.slats);
    expect(blindsLightBand(1.3, w, s)).toBe(0);
    expect(blindsLightBand(-1.3, w, s)).toBe(0);
    expect(blindsLightBand(0, 0.62, s)).toBe(0);
    expect(blindsLightBand(0, -0.62, s)).toBe(0);
    expect(blindsLightBand(BOX_X, w, s)).toBe(0);
    expect(blindsLightBand(0, BOX_W, s)).toBe(0);
  });

  it("is softly half-lit at the footprint's side edges", () => {
    const w = gapCentre(4, s.slats);
    const t = bandT(1, s.side);
    expect(blindsLightBand(1, w, s)).toBeCloseTo(0.5 * (1 - FALLOFF * t), 10);
  });

  it("follows the slanted stripes in screen space", () => {
    const w = gapCentre(3, s.slats);
    const [x0, y0] = toPoint(0.5, w, s);
    const [x1, y1] = toPoint(-0.2, w, s);
    expect(y1).not.toBeCloseTo(y0, 0);
    expect(blindsLight(x0, y0, s)).toBeCloseTo(blindsLightBand(0.5, w, s), 10);
    expect(blindsLight(x1, y1, s)).toBeCloseTo(blindsLightBand(-0.2, w, s), 10);
    expect(blindsLight(x1, y1, s)).toBeGreaterThan(0.6);
  });

  it("has softer stripe edges away from the window", () => {
    const edge = gapCentre(4, s.slats) + HALF_DUTY / s.slats;
    const d = 0.08 / s.slats;
    // Relative to the stripe centre, so the falloff doesn't count.
    const rel = (xn: number, dw: number) =>
      blindsLightBand(xn, edge + dw, s) / blindsLightBand(xn, gapCentre(4, s.slats), s);
    const nearSpread = rel(0.8, -d) - rel(0.8, d);
    const farSpread = rel(-0.8, -d) - rel(-0.8, d);
    expect(farSpread).toBeLessThan(nearSpread);
  });

  it("stays in [0, 1] everywhere", () => {
    for (const soft of [0, 1]) {
      const sh = shape("left", 60, 20, soft);
      let min = Infinity;
      let max = -Infinity;
      for (let xn = -1.4; xn <= 1.4; xn += 0.07) {
        for (let w = -0.7; w <= 0.7; w += 0.013) {
          const v = blindsLightBand(xn, w, sh);
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
      }
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(1);
    }
  });
});

describe("cloud dimming", () => {
  it("is exactly 1 with no clouds", () => {
    for (const n of [-1, 0, 0.5, 1]) {
      expect(sunLevel(n, 0)).toBe(1);
    }
    expect(sunLevelAt(createNoise(1), 123.4, 0)).toBe(1);
  });

  it("stays within [1 - MAX_DIP, 1]", () => {
    for (let c = 0; c <= 1; c += 0.1) {
      for (let n = -1.5; n <= 1.5; n += 0.05) {
        const v = sunLevel(n, c);
        expect(v).toBeGreaterThanOrEqual(1 - MAX_DIP - 1e-12);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    expect(sunLevel(1, 1)).toBeCloseTo(1 - MAX_DIP, 10);
  });

  it("is continuous over time and dips now and then", () => {
    const noise = createNoise(25);
    for (const clouds of [0.4, 1]) {
      let prev = sunLevelAt(noise, 0, clouds);
      let min = prev;
      let maxStep = 0;
      for (let t = 0.05; t < 900; t += 0.05) {
        const v = sunLevelAt(noise, t, clouds);
        maxStep = Math.max(maxStep, Math.abs(v - prev));
        min = Math.min(min, v);
        prev = v;
      }
      // No faster than 0.2 per second: the deepest dip takes a few seconds.
      expect(maxStep).toBeLessThan(0.01);
      expect(min).toBeLessThan(clouds === 1 ? 0.6 : 0.85);
    }
  });

  it("is continuous in the clouds param", () => {
    for (let c = 0; c < 1; c += 0.01) {
      expect(Math.abs(sunLevel(0.4, c + 0.01) - sunLevel(0.4, c))).toBeLessThan(0.06);
    }
  });

  it("cools the sun colour as it dips", () => {
    const light: Rgb = [1, 0.85, 0.63];
    const out: Rgb = [0, 0, 0];
    sunColor(out, light, 1, 0.5);
    expect(out).toEqual([0.5, 0.425, 0.315]);
    sunColor(out, light, 1 - MAX_DIP, 1);
    for (let i = 0; i < 3; i++) {
      expect(out[i]).toBeCloseTo(light[i] * DIM_TINT[i] * 0.5, 10);
    }
    expect(out[2] / out[0]).toBeGreaterThan(light[2] / light[0]);
  });
});
