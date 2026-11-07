import { describe, expect, it } from "vitest";
import {
  buildFadeMask,
  buildRockTable,
  createEmitters,
  LANTERN_H,
  MASK_H,
  MASK_W,
  meltMask,
  nearTopAt,
  paletteFor,
  PALETTES,
  type SpringPalette,
  RIPPLE_PERIOD,
  ripplePhases,
  ROCK_CHANNELS,
  ROCK_COLUMNS,
  ROCK_ROWS,
  springDraft,
  springEmitters,
  springLayout,
  steamGrid,
  steamRegion,
  STEAM_SCALE,
  WATERLINE,
} from "./hotspring-sim";
import { FLAKE_FLOATS, type FlakeFrame, createFlakes } from "../snow/snow-sim";
import type { Rgb } from "../color";

/** A palette's fields, typed so `Object.values` sees through the interface. */
const paletteFields = (p: SpringPalette): Readonly<Record<string, number | Rgb>> => ({ ...p });

const ASPECTS = { "4:3": 4 / 3, "16:9": 16 / 9, "21:9": 21 / 9 };

/** Bilinear sample of the fade mask at device px (x, y down) on a w x h canvas, as the GPU does. */
function sampleMask(mask: Uint8Array, px: number, py: number, w: number, h: number): number {
  const fx = Math.min(Math.max((px / w) * MASK_W - 0.5, 0), MASK_W - 1);
  const fy = Math.min(Math.max((py / h) * MASK_H - 0.5, 0), MASK_H - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, MASK_W - 1);
  const y1 = Math.min(y0 + 1, MASK_H - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (x: number, y: number) => mask[y * MASK_W + x] / 255;
  const top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const bottom = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
}

describe("springLayout", () => {
  for (const [name, aspect] of Object.entries(ASPECTS)) {
    it(`keeps the pool at the bottom and rocks at the sides at ${name}`, () => {
      const l = springLayout(aspect);
      // The open pool spans the middle third.
      expect(l.poolX0).toBeLessThan(aspect / 3);
      expect(l.poolX1).toBeGreaterThan((2 * aspect) / 3);
      expect(l.poolX0).toBeGreaterThan(0.1 * aspect);
      // No rock rises above the water in the middle third.
      let worst = -Infinity;
      for (let x = aspect / 3; x <= (2 * aspect) / 3; x += 0.005) {
        worst = Math.max(worst, nearTopAt(l, x));
      }
      expect(worst).toBeLessThan(0);
      // Tall rocks at both frame edges.
      expect(nearTopAt(l, 0.01)).toBeGreaterThan(WATERLINE + 0.15);
      expect(nearTopAt(l, aspect - 0.01)).toBeGreaterThan(WATERLINE + 0.15);
      // The lantern stands on the right-hand rocks, clear of the middle third.
      expect(l.lanternX).toBeGreaterThan((2 * aspect) / 3);
      expect(l.lanternY).toBeGreaterThan(WATERLINE);
      expect(l.lanternY + LANTERN_H).toBeLessThan(l.top);
      expect(l.top).toBeLessThan(0.7);
      // The steam box covers the open pool and stays in the frame.
      expect(l.steam[0]).toBeGreaterThanOrEqual(0);
      expect(l.steam[2]).toBeLessThanOrEqual(aspect);
      expect(l.steam[0]).toBeLessThan(l.poolX0);
      expect(l.steam[2]).toBeGreaterThan(l.poolX1);
      expect(l.steam[1]).toBeLessThan(WATERLINE);
    });
  }

  it("fills the rock table with sane rows", () => {
    const aspect = 16 / 9;
    const l = springLayout(aspect);
    const data = new Float32Array(ROCK_COLUMNS * ROCK_ROWS * ROCK_CHANNELS);
    buildRockTable(l, data);
    let bad = 0;
    let farStones = 0;
    for (let c = 0; c < ROCK_COLUMNS; c++) {
      const x = ((c + 0.5) / ROCK_COLUMNS) * aspect;
      const o = c * ROCK_CHANNELS;
      if (Math.abs(data[o] - nearTopAt(l, x)) > 1e-6) {
        bad++;
      }
      // Caps are never deeper than the rock, and creases stay in 0..1.
      if (data[o + 2] < 0 || data[o + 2] > 0.03 || data[o + 3] < 0 || data[o + 3] > 1) {
        bad++;
      }
      const far = (ROCK_COLUMNS + c) * ROCK_CHANNELS;
      if (data[far] > data[far + 1]) {
        farStones++;
        if (data[far] > WATERLINE + 0.06 || data[far + 1] < WATERLINE - 0.02) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
    expect(farStones).toBeGreaterThan(ROCK_COLUMNS * 0.2);
  });
});

describe("snow fade mask", () => {
  it("is 1 away from the pool, 0 in the water, and smooth in between", () => {
    const l = springLayout(16 / 9);
    expect(meltMask(l, 0.6, 0.01, 0.1)).toBe(1);
    expect(meltMask(l, 0.6, 16 / 18, 0.9)).toBe(1);
    expect(meltMask(l, 0.6, 16 / 18, WATERLINE - 0.05)).toBe(0);
    expect(meltMask(l, 0.6, 16 / 18, WATERLINE + 0.1)).toBeGreaterThan(0);
    expect(meltMask(l, 0.6, 16 / 18, WATERLINE + 0.1)).toBeLessThan(1);
    // More steam melts flakes higher up.
    expect(meltMask(l, 1, 16 / 18, WATERLINE + 0.15)).toBeLessThan(
      meltMask(l, 0.2, 16 / 18, WATERLINE + 0.15),
    );
  });

  it("fades snowflakes out in the steam without popping", () => {
    const w = 1920;
    const h = 1080;
    const aspect = w / h;
    const l = springLayout(aspect);
    const mask = new Uint8Array(MASK_W * MASK_H);
    const max = 300;
    const data = new Float32Array(max * FLAKE_FLOATS);
    const f: FlakeFrame = {
      refWidth: w,
      scale: 1,
      count: max,
      speed: 0.55,
      wind: 0.12,
      gustiness: 0.3,
      sway: 0.5,
      size: 3,
      depthBlur: 0.6,
      brightness: 0.85,
    };
    for (const steam of [0, 0.6, 1]) {
      buildFadeMask(l, steam, mask);
      const flakes = createFlakes(max, w);
      const prevY = new Float32Array(max);
      const prevA = new Float32Array(max).fill(-1);
      let worstDrop = 0;
      let worstRise = 0;
      let melted = 0;
      // Every flake is written in the same layer order each frame, so track by its
      // index in `xs` / `ys` rather than by the output slot.
      for (let k = 0; k < 600; k++) {
        flakes.step(1 / 30, f, data, FLAKE_FLOATS);
        for (let i = 0; i < max; i++) {
          const y = flakes.ys[i];
          const a = sampleMask(mask, flakes.xs[i], y, w, h);
          // Skip the frame a flake wraps back to the top.
          if (prevA[i] >= 0 && y > prevY[i]) {
            worstDrop = Math.max(worstDrop, prevA[i] - a);
            worstRise = Math.max(worstRise, a - prevA[i]);
            if (a === 0 && prevA[i] > 0) {
              melted++;
            }
          }
          prevA[i] = a;
          prevY[i] = y;
        }
      }
      // At 30 fps the fastest near flake moves about 2.6 px a frame.
      expect(worstDrop).toBeLessThan(0.08);
      // Sideways drift over the pool's edge can bring a little back, never suddenly.
      expect(worstRise).toBeLessThan(0.08);
      expect(melted).toBeGreaterThan(20);
    }
  });

  it("writes row 0 at the top of the frame", () => {
    const l = springLayout(16 / 9);
    const mask = new Uint8Array(MASK_W * MASK_H);
    buildFadeMask(l, 0.5, mask);
    const mid = MASK_W >> 1;
    expect(mask[mid]).toBe(255);
    expect(mask[(MASK_H - 1) * MASK_W + mid]).toBe(0);
  });
});

describe("steam", () => {
  it("maps the box into sim space around the pool's far edge", () => {
    const l = springLayout(16 / 9);
    const r = new Float64Array(4);
    steamRegion(l, r);
    expect(r[0]).toBeCloseTo((l.steam[0] - (16 / 9) * 0.5) * STEAM_SCALE, 10);
    expect(r[1]).toBeLessThan(0);
    expect(r[1] + r[3]).toBeGreaterThan(0);
    const g = [0, 0];
    steamGrid(l, g);
    expect(g[0] * g[1]).toBeLessThan(120_000);
  });

  it("emits along the pool, scaled by the steam param, and nothing at 0", () => {
    const l = springLayout(16 / 9);
    const e = createEmitters();
    springEmitters(l, 0, e);
    expect(e.far[3]).toBe(0);
    expect(e.near[3]).toBe(0);
    springEmitters(l, 1, e);
    expect(e.far[3]).toBe(1);
    expect(e.near[3]).toBeGreaterThan(0);
    expect(e.near[1]).toBeLessThan(e.far[1]);
    expect(e.far[2]).toBeGreaterThan(((l.poolX1 - l.poolX0) / 2) * STEAM_SCALE);
    springEmitters(l, Number.NaN, e);
    expect(e.far[3]).toBe(0);
    springEmitters(l, 5, e);
    expect(e.far[3]).toBe(1);
  });

  it("drifts sideways smoothly", () => {
    let worst = 0;
    let prev = springDraft(0);
    for (let t = 0.1; t < 400; t += 0.1) {
      const d = springDraft(t);
      worst = Math.max(worst, Math.abs(d - prev));
      prev = d;
    }
    expect(worst).toBeLessThan(0.01);
  });
});

describe("ripplePhases", () => {
  it("wraps seamlessly over the period", () => {
    const a = new Float64Array(4);
    const b = new Float64Array(4);
    ripplePhases(12.5, a);
    ripplePhases(12.5 + RIPPLE_PERIOD, b);
    for (let i = 0; i < 4; i++) {
      expect(b[i]).toBeCloseTo(a[i], 9);
    }
  });
});

describe("palettes", () => {
  it("falls back to dusk", () => {
    expect(paletteFor("nope")).toBe(PALETTES.dusk);
    expect(paletteFor("night")).toBe(PALETTES.night);
  });

  it("keeps colours in range, and night darker than day", () => {
    const out = Object.values(PALETTES)
      .flatMap((p) => Object.values(paletteFields(p)).flat())
      .filter((c) => !(c >= 0 && c <= 1.2));
    expect(out).toEqual([]);
    expect(PALETTES.night.snow[1]).toBeLessThan(PALETTES.day.snow[1]);
    expect(PALETTES.night.lantern).toBeGreaterThan(PALETTES.day.lantern);
  });
});
