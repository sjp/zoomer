import { describe, expect, it } from "vitest";
import type { Rgb } from "../color";
import { MAX_FEATURE_PX_PER_FRAME, pxPerReferenceFrame } from "../motion-limits";
import { createRain, stepRain } from "../porch/porch-sim";
import {
  blobColours,
  createShapes,
  createWindowGeometry,
  MAX_SPIN,
  RAIN_DROPS,
  RAIN_PACE,
  rainProgress,
  rotateHue,
  SHAPE_COUNT,
  SHAPE_MARGIN,
  shapeAngle,
  shapeSway,
  stepShapes,
  windowGeometry,
  windowRainSpeed,
} from "./startingsoon-backdrop-sim";

const ASPECTS = [
  ["16:9", 16 / 9],
  ["4:3", 4 / 3],
  ["21:9", 21 / 9],
  ["9:16", 9 / 16],
] as const;

describe("rotateHue", () => {
  it("keeps a colour at 0 and 360 degrees, and greys at any angle", () => {
    const out: Rgb = [0, 0, 0];
    const c: Rgb = [0.8, 0.3, 0.5];
    for (const turn of [0, 360]) {
      rotateHue(c, turn, out);
      out.forEach((v, i) => {
        expect(v).toBeCloseTo(c[i], 6);
      });
    }
    rotateHue([0.4, 0.4, 0.4], 77, out);
    out.forEach((v) => {
      expect(v).toBeCloseTo(0.4, 6);
    });
  });

  it("turns red to green in a third of a turn", () => {
    const out = rotateHue([1, 0, 0], 120, [0, 0, 0]);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(1, 6);
    expect(out[2]).toBeCloseTo(0, 6);
  });
});

describe("blobColours", () => {
  it("fills six dimmed linear colours from the accent", () => {
    const out = new Float32Array(18).fill(-1);
    blobColours([0.55, 0.42, 1], 2.2, out);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      // Never brighter than 0.75 of full in sRGB, so white text reads over them.
      expect(v).toBeLessThanOrEqual(0.75 ** 2.2 + 1e-6);
    }
  });
});

describe("windowGeometry", () => {
  it.each(ASPECTS)("at %s keeps the window, desk and lamp in the frame", (_, aspect) => {
    const g = windowGeometry(aspect, createWindowGeometry());
    const half = aspect / 2;
    expect(g.cx - g.hw - g.bar).toBeGreaterThan(-half);
    expect(g.cx + g.hw + g.bar).toBeLessThan(half);
    expect(g.cy + g.hh + g.bar).toBeLessThan(0.5);
    expect(g.cy - g.hh - g.bar).toBeGreaterThan(g.deskY);
    expect(Math.abs(g.lampX) + 0.06).toBeLessThan(half);
    expect(Math.abs(g.crossY)).toBeLessThan(g.hh);
  });
});

describe("window rain", () => {
  it.each([0, 0.5, 1])("at depth %d falls within the codec's per-frame limit", (depth) => {
    const g = windowGeometry(16 / 9, createWindowGeometry());
    expect(pxPerReferenceFrame(windowRainSpeed(depth, 2 * g.hh))).toBeLessThanOrEqual(
      MAX_FEATURE_PX_PER_FRAME,
    );
  });

  it("keeps every drop's progress down the glass within 0..1 as it steps", () => {
    const rain = createRain(7, RAIN_DROPS);
    for (let f = 0; f < 600; f++) {
      stepRain(rain, RAIN_DROPS, (1 / 30) * RAIN_PACE, 0, 1);
      for (let i = 0; i < RAIN_DROPS; i += 13) {
        const t = rainProgress(rain.y[i], rain.depth[i]);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThan(1);
      }
    }
  });
});

describe("shapes", () => {
  it("are the same set every time, prefix-stable", () => {
    const a = createShapes(SHAPE_COUNT);
    const b = createShapes(SHAPE_COUNT + 4);
    expect(Array.from(b.x.subarray(0, SHAPE_COUNT))).toEqual(Array.from(a.x));
    expect(Array.from(b.half.subarray(0, SHAPE_COUNT))).toEqual(Array.from(a.half));
  });

  it("spread across the frame and use every kind", () => {
    const s = createShapes(SHAPE_COUNT);
    expect(Math.min(...s.x)).toBeLessThan(0.15);
    expect(Math.max(...s.x)).toBeGreaterThan(0.85);
    expect(new Set(s.kind).size).toBe(5);
  });

  it("rise and wrap within the frame's margin", () => {
    const s = createShapes(SHAPE_COUNT);
    for (let f = 0; f < 3000; f++) {
      stepShapes(s, 0.1);
    }
    for (const y of s.y) {
      expect(y).toBeGreaterThanOrEqual(-SHAPE_MARGIN);
      expect(y).toBeLessThan(1080 + SHAPE_MARGIN);
    }
  });

  it("move slowly: rise, sway and spin stay far under the codec's per-frame limit", () => {
    const s = createShapes(SHAPE_COUNT);
    const x0 = Array.from({ length: SHAPE_COUNT }, (_, i) => shapeSway(s, i));
    const y0 = Array.from(s.y);
    const a0 = Array.from({ length: SHAPE_COUNT }, (_, i) => shapeAngle(s, i));
    stepShapes(s, 1 / 30);
    for (let i = 0; i < SHAPE_COUNT; i++) {
      const moved = Math.hypot(shapeSway(s, i) - x0[i], s.y[i] - y0[i]);
      const rim = Math.abs(shapeAngle(s, i) - a0[i]) * s.half[i];
      expect(moved + rim).toBeLessThan(MAX_FEATURE_PX_PER_FRAME / 4);
    }
    expect(MAX_SPIN).toBeLessThan(0.5);
  });
});
