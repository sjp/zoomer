import { describe, expect, it } from "vitest";
import { MAX_PATTERN_HZ } from "../motion-limits";
import { synthwaveMeta } from "./synthwave.meta";
import {
  BACK_HEIGHT,
  createRowScene,
  EDGE_WIDTH,
  fillRows,
  FRONT_HEIGHT,
  generateRidge,
  getRidgeData,
  gridScrollSpeed,
  mountainTop,
  RIDGE_POINTS,
  RIDGE_SPAN,
  ridgeEnvelope,
  ROW_FLOATS,
  type RowColors,
  sunGaps,
} from "./synthwave-sim";

describe("generateRidge", () => {
  it("spans exactly 0..1", () => {
    const out = new Float32Array(129);
    generateRidge(out, 150405, 0.55);
    expect(Math.min(...out)).toBe(0);
    expect(Math.max(...out)).toBe(1);
  });

  it("is deterministic for a seed and differs between seeds", () => {
    const a = new Float32Array(129);
    const b = new Float32Array(129);
    const c = new Float32Array(129);
    generateRidge(a, 57466, 0.5);
    generateRidge(b, 57466, 0.5);
    generateRidge(c, 57467, 0.5);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });
});

describe("buildRidgeData", () => {
  const last = RIDGE_POINTS - 1;

  it("scales each ridge by the envelope, keeping the middle low for the sun", () => {
    const data = getRidgeData();
    expect(data).toHaveLength(RIDGE_POINTS * 2);
    const ridge = new Float32Array(RIDGE_POINTS);
    const wrong: string[] = [];
    [150405, 57466].forEach((seed, row) => {
      generateRidge(ridge, seed, row === 0 ? 0.55 : 0.5);
      for (let i = 0; i <= last; i++) {
        const v = data[row * RIDGE_POINTS + i];
        const env = ridgeEnvelope(i / last);
        // toBeCloseTo(_, 6): within half of 1e-6.
        const ok = Math.abs(v - ridge[i] * env) < 5e-7 && v >= 0 && v <= env + 1e-6;
        if (!ok && wrong.length < 10) {
          wrong.push(`ridge ${String(row)}, point ${String(i)}: ${String(v)}`);
        }
      }
    });
    expect(wrong).toEqual([]);
  });

  it("has an envelope of 0.2 in the middle rising to 1 at the sides", () => {
    expect(ridgeEnvelope(0.5)).toBeCloseTo(0.2, 12);
    expect(ridgeEnvelope(0)).toBe(1);
    expect(ridgeEnvelope(1)).toBe(1);
    for (let x = 0; x < 0.5; x += 0.01) {
      expect(ridgeEnvelope(x)).toBeGreaterThanOrEqual(ridgeEnvelope(x + 0.01) - 1e-12);
      expect(ridgeEnvelope(1 - x)).toBeCloseTo(ridgeEnvelope(x), 12);
    }
  });
});

describe("mountainTop", () => {
  /**
   * The highest y each range's shading reaches, mirroring the shader's ridgeDist:
   * a pixel is touched where the signed distance below the edge exceeds -reach
   * (0.5 for the back range's AA, half the edge line plus 0.5 for the front).
   */
  function highestReach(hy: number, width: number, height: number, scale: number): number {
    const data = getRidgeData();
    const span = RIDGE_SPAN * width;
    const segs = RIDGE_POINTS - 1;
    let top = Infinity;
    for (const [row, maxH, reach] of [
      [0, BACK_HEIGHT * height, 0.5],
      [1, FRONT_HEIGHT * height, 0.5 * EDGE_WIDTH * scale + 0.5],
    ]) {
      for (let i = 0; i < segs; i++) {
        const a = data[row * RIDGE_POINTS + i];
        const b = data[row * RIDGE_POINTS + i + 1];
        const s = ((a - b) * maxH * segs) / span;
        for (let f = 0; f <= 1; f += 0.125) {
          const y = hy + 1 - (a + (b - a) * f) * maxH;
          top = Math.min(top, y - reach * Math.sqrt(1 + s * s));
        }
      }
    }
    return top;
  }

  it.each([
    [1920, 1080],
    [3840, 2160],
    [1280, 1024],
    [640, 1600],
    [320, 180],
  ])("lies above every ridge sample plus its AA reach at %ix%i", (width, height) => {
    const scale = height / 1080;
    for (const horizon of [0.25, 0.45, 0.75]) {
      const hy = height * (1 - horizon);
      const top = mountainTop(hy, width, height, scale);
      const reach = highestReach(hy, width, height, scale);
      expect(top).toBeLessThanOrEqual(reach);
      // ...but still skips the sky above the tallest range's full height.
      expect(top).toBeGreaterThan(hy - BACK_HEIGHT * height - 5);
    }
  });
});

describe("fillRows", () => {
  const colors: RowColors = {
    skyTop: [0.1, 0, 0.2],
    skyMid: [0.3, 0.1, 0.4],
    skyBottom: [0.5, 0.2, 0.6],
    grid: [1, 0.2, 0.8],
    core: [1, 0.6, 0.9],
    haze: [0.7, 0.2, 0.7],
  };

  /** A 1080p scene like the effect's defaults, with the sun stripes on or off. */
  function scene(stripes: boolean, scanlines = false, phase = 0.3) {
    const height = 1080;
    const s = createRowScene();
    s.height = height;
    s.hy = height * 0.55;
    s.k = height - s.hy;
    const r = 0.24 * height;
    const sunY = s.hy - r * 0.45;
    s.sunTop = sunY - r;
    s.sunClip = Math.min(sunY + r, s.hy + 1);
    sunGaps(s.gaps, sunY, r, phase, stripes, s.sunClip);
    s.scanPeriod = scanlines ? 4 : 0;
    s.glowW = 8;
    s.coreW = 1.6;
    s.glowA = 0.13;
    s.cell = 0.5;
    s.scroll = 0.2;
    const rows = new Float32Array(height * ROW_FLOATS);
    fillRows(rows, height, s, colors);
    return { s, rows, height };
  }
  /** Canvas y (down) of the centre of texture row `row`. */
  const yOf = (height: number, row: number) => height - row - 0.5;

  it("keeps coverages and masks within [0, 1]", () => {
    const wrong: string[] = [];
    for (const stripes of [true, false]) {
      for (const scanlines of [true, false]) {
        const { rows, height } = scene(stripes, scanlines);
        for (let row = 0; row < height; row++) {
          const o = row * ROW_FLOATS;
          for (const i of [3, 7, 11]) {
            const v = rows[o + i];
            if (!(v >= 0 && v <= 1) && wrong.length < 10) {
              wrong.push(
                `stripes ${String(stripes)}, scanlines ${String(scanlines)}, row ${String(row)}[${String(i)}]: ${String(v)}`,
              );
            }
          }
        }
        expect(rows.every((v) => Number.isFinite(v))).toBe(true);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("covers the whole sun with the stripes off", () => {
    const { s, rows, height } = scene(false);
    const inside: number[] = [];
    const outside: number[] = [];
    for (let row = 0; row < height; row++) {
      const y = yOf(height, row);
      const cov = rows[row * ROW_FLOATS + 3];
      if (y >= s.sunTop + 0.5 && y <= s.sunClip - 0.5) {
        inside.push(cov);
      } else if (y < s.sunTop - 0.5 || y > s.sunClip + 0.5) {
        outside.push(cov);
      }
    }
    expect(inside.length).toBeGreaterThan(200);
    expect(new Set(inside)).toEqual(new Set([1]));
    expect(new Set(outside)).toEqual(new Set([0]));
  });

  it("cuts gaps out of the sun with the stripes on", () => {
    const { s, rows, height } = scene(true);
    let gapRows = 0;
    for (let row = 0; row < height; row++) {
      const y = yOf(height, row);
      if (y > s.sunTop + 0.5 && y < s.sunClip - 0.5 && rows[row * ROW_FLOATS + 3] === 0) {
        gapRows++;
      }
    }
    expect(gapRows).toBeGreaterThan(10);
  });

  it("draws no grid above the horizon", () => {
    const { s, rows, height } = scene(true);
    let gridRows = 0;
    let skyGrid = 0;
    for (let row = 0; row < height; row++) {
      const o = row * ROW_FLOATS;
      const lit = [8, 9, 10, 11].some((i) => rows[o + i] !== 0);
      if (yOf(height, row) <= s.hy) {
        skyGrid += lit ? 1 : 0;
      } else {
        gridRows += lit ? 1 : 0;
      }
    }
    expect(skyGrid).toBe(0);
    expect(gridRows).toBeGreaterThan(100);
  });

  it("darkens every other pair of rows with the scanlines on", () => {
    const plain = scene(true, false).rows;
    const { rows, height } = scene(true, true);
    const wrong: string[] = [];
    for (let row = 0; row < height; row++) {
      const o = row * ROW_FLOATS + 7;
      const dark = Math.floor(yOf(height, row)) % 4 < 2;
      const want = plain[o] * (dark ? 0.84 : 1);
      // toBeCloseTo(_, 6): within half of 1e-6.
      if (!(Math.abs(rows[o] - want) < 5e-7) && wrong.length < 10) {
        wrong.push(`row ${String(row)}: ${String(rows[o])}, want ${String(want)}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("gridScrollSpeed", () => {
  const { speed, gridSize } = synthwaveMeta.params;

  it("keeps the default speed and cell size", () => {
    expect(gridScrollSpeed(speed.default, gridSize.default)).toBeCloseTo(1.2 * speed.default, 12);
  });

  it("never passes lines faster than MAX_PATTERN_HZ at any slider value", () => {
    for (let s = speed.min; s <= speed.max + 1e-9; s += speed.step) {
      for (let c = gridSize.min; c <= gridSize.max + 1e-9; c += gridSize.step) {
        const v = gridScrollSpeed(s, c);
        expect(v / c).toBeLessThanOrEqual(MAX_PATTERN_HZ + 1e-9);
        expect(v).toBeLessThanOrEqual(1.2 * s + 1e-12);
      }
    }
  });

  it("still gets faster with speed below the cap", () => {
    expect(gridScrollSpeed(1, 1.2)).toBeLessThan(gridScrollSpeed(2, 1.2));
  });
});
