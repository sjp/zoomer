import { describe, expect, it } from "vitest";
import { createRng } from "./noise";
import {
  advanceFoam,
  createFoamField,
  createShoreScheduler,
  createSpray,
  fillRockTable,
  fillSeaTable,
  FOAM_CELL,
  type FoamField,
  foamColumns,
  HORIZON,
  LIFETIME,
  MAX_FOAM_COLUMNS,
  MAX_SPRAY,
  MAX_WAVES,
  PALETTES,
  paletteFor,
  ROCK_BASE,
  ROCK_COLUMNS,
  ROCK_FLOATS,
  ROCK_MAX,
  ROCK_MIDDLE_MAX,
  rockHeight,
  SEA_COLUMNS,
  SEA_FLOATS,
  SPACING_MAX,
  SPACING_MIN,
  SPRAY_ALPHA,
  SPRAY_FLOATS,
  stepSpray,
  WATER_Y,
  waveReach,
  waveTau,
  writeSpray,
} from "./shore-sim";
import { MAX_PERIOD, MIN_PERIOD, ROCKS_OPTIONS, SKY_OPTIONS } from "./shore.meta";
import { T_APPROACH, T_STOP } from "./wash";

const ASPECT = 16 / 9;

const rocks = (layout: string, seed = 3, aspect = ASPECT) =>
  fillRockTable(new Float32Array(ROCK_COLUMNS * ROCK_FLOATS), aspect, layout, seed);

/** Tallest rock over x in [x0, x1] (height units). */
function tallest(table: Float32Array, x0: number, x1: number, aspect = ASPECT): number {
  let m = 0;
  for (let i = 0; i < ROCK_COLUMNS; i++) {
    const x = ((i + 0.5) / ROCK_COLUMNS) * aspect;
    if (x >= x0 && x <= x1) m = Math.max(m, table[i * ROCK_FLOATS]);
  }
  return m;
}

describe("fillRockTable", () => {
  it("is deterministic per seed and varies between seeds", () => {
    expect(rocks("right", 5)).toEqual(rocks("right", 5));
    expect(rocks("right", 5)).not.toEqual(rocks("right", 6));
  });

  it("stays bounded, low in the middle third, and leaves gaps below the water", () => {
    for (const { value } of ROCKS_OPTIONS) {
      for (let seed = 0; seed < 20; seed++) {
        const t = rocks(value, seed);
        let lo = Infinity;
        let hi = -Infinity;
        let gaps = 0;
        for (let i = 0; i < ROCK_COLUMNS; i++) {
          const h = t[i * ROCK_FLOATS];
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
          if (h < WATER_Y) gaps++;
        }
        expect(lo).toBeGreaterThan(ROCK_BASE - 0.02);
        expect(hi).toBeLessThanOrEqual(ROCK_MAX);
        expect(tallest(t, ASPECT / 3, (2 * ASPECT) / 3)).toBeLessThanOrEqual(ROCK_MIDDLE_MAX);
        expect(gaps).toBeGreaterThan(ROCK_COLUMNS * 0.03);
      }
    }
  });

  it("stands taller at the named side", () => {
    for (let seed = 0; seed < 10; seed++) {
      const left = rocks("left", seed);
      const right = rocks("right", seed);
      expect(tallest(left, 0, 0.4)).toBeGreaterThan(tallest(left, ASPECT - 0.4, ASPECT) + 0.05);
      expect(tallest(right, ASPECT - 0.4, ASPECT)).toBeGreaterThan(tallest(right, 0, 0.4) + 0.05);
      expect(tallest(right, ASPECT - 0.4, ASPECT)).toBeGreaterThan(0.33);
    }
  });

  it("stores slopes matching the heights, and rockHeight interpolates them", () => {
    const t = rocks("across");
    const dx = ASPECT / ROCK_COLUMNS;
    let bad = 0;
    for (let i = 1; i < ROCK_COLUMNS - 1; i++) {
      const s = (t[(i + 1) * ROCK_FLOATS] - t[(i - 1) * ROCK_FLOATS]) / (2 * dx);
      if (Math.abs(s - t[i * ROCK_FLOATS + 1]) > 1e-3 * (1 + Math.abs(s))) bad++;
    }
    expect(bad).toBe(0);
    const i = 700;
    const x = ((i + 0.5) / ROCK_COLUMNS) * ASPECT;
    expect(rockHeight(t, ASPECT, x)).toBeCloseTo(t[i * ROCK_FLOATS], 6);
  });
});

describe("createShoreScheduler", () => {
  it("starts a wave every period, within the spacing jitter", () => {
    for (const period of [MIN_PERIOD, 12, MAX_PERIOD]) {
      const s = createShoreScheduler(11);
      const starts: number[] = [];
      let maxCount = 0;
      let last = 0;
      for (let i = 0; i < 6000; i++) {
        s.step(1 / 30, period);
        maxCount = Math.max(maxCount, s.count);
        if (s.spawned !== last) {
          last = s.spawned;
          starts.push(s.waves[s.count - 1].start);
        }
      }
      let bad = 0;
      for (let i = 1; i < starts.length; i++) {
        const gap = starts[i] - starts[i - 1];
        if (gap < period * SPACING_MIN - 0.05 || gap > period * SPACING_MAX + 0.05) bad++;
      }
      expect(bad).toBe(0);
      expect(starts.length).toBeGreaterThan(200 / (period * SPACING_MAX) - 1);
      expect(maxCount).toBeLessThanOrEqual(MAX_WAVES);
    }
  });

  it("is deterministic per seed and resets", () => {
    const a = createShoreScheduler(4);
    const b = createShoreScheduler(9);
    for (let i = 0; i < 900; i++) a.step(1 / 30, 10);
    b.reset(4);
    for (let i = 0; i < 900; i++) b.step(1 / 30, 10);
    expect(b.count).toBe(a.count);
    expect(b.waves.slice(0, b.count)).toEqual(a.waves.slice(0, a.count));
    a.reset(1);
    expect(a.count).toBe(0);
    expect(a.time).toBe(0);
  });

  it("retires waves after their lifetime", () => {
    const s = createShoreScheduler(2);
    s.step(0, MAX_PERIOD);
    expect(s.count).toBe(1);
    s.step(LIFETIME - 0.01, MAX_PERIOD);
    expect(s.count).toBe(1);
    s.step(0.02, MAX_PERIOD);
    expect(s.count).toBe(0);
  });
});

describe("fillSeaTable", () => {
  const out = new Float32Array(SEA_COLUMNS * SEA_FLOATS);

  it("shows a swell on the approach, then a surge up to the reach after the break", () => {
    const s = createShoreScheduler(1);
    s.step(0, MAX_PERIOD);
    const w = s.waves[0];
    const reach = waveReach(w, 0.5);
    let swellSeen = false;
    let peak = 0;
    let surgeBeforeBreak = 0;
    let swellOutOfRange = 0;
    for (let t = 0; t < 14; t += 0.1) {
      fillSeaTable(s, ASPECT, 0.5, out);
      for (let c = 0; c < SEA_COLUMNS; c++) {
        const o = c * SEA_FLOATS;
        const x = ((c + 0.5) / SEA_COLUMNS) * ASPECT;
        const tau = waveTau(w, s.time, x, ASPECT);
        if (tau < T_APPROACH - 0.5) surgeBeforeBreak = Math.max(surgeBeforeBreak, out[o]);
        peak = Math.max(peak, out[o]);
        if (out[o + 3] > 0.5) {
          swellSeen = true;
          if (out[o + 1] > HORIZON || out[o + 1] < 0 || !(out[o + 2] > 0)) swellOutOfRange++;
        }
      }
      s.step(0.1, MAX_PERIOD);
    }
    expect(swellSeen).toBe(true);
    expect(swellOutOfRange).toBe(0);
    expect(surgeBeforeBreak).toBe(0);
    expect(peak).toBeGreaterThan(reach * 0.95);
    expect(peak).toBeLessThanOrEqual(reach + 1e-6);
  });
});

/** Highest foam density in the field. */
function maxFoam(foam: FoamField): number {
  let m = 0;
  for (let i = 0; i < foam.density.length; i++) m = Math.max(m, foam.density[i]);
  return m;
}

describe("foam", () => {
  it("sizes its columns to the frame", () => {
    expect(foamColumns(ASPECT)).toBe(Math.ceil(ASPECT / FOAM_CELL));
    expect(foamColumns(100)).toBe(MAX_FOAM_COLUMNS);
    expect(createFoamField(ASPECT).density.length).toBe(foamColumns(ASPECT) * 72);
  });

  it("stays bounded under the biggest, most frequent waves", () => {
    const table = rocks("across");
    const s = createShoreScheduler(8);
    const foam = createFoamField(ASPECT);
    let peak = 0;
    let bad = 0;
    for (let i = 0; i < 24 * 30; i++) {
      s.step(1 / 30, MIN_PERIOD);
      advanceFoam(foam, s, table, ASPECT, 1, 1 / 30);
      if (i % 3 !== 0) continue;
      for (let k = 0; k < foam.density.length; k++) {
        const d = foam.density[k];
        if (!(d >= 0 && d <= 1) || !(foam.wet[k] >= 0 && foam.wet[k] <= 1)) bad++;
        if (d > peak) peak = d;
      }
    }
    expect(bad).toBe(0);
    expect(peak).toBeGreaterThan(0.8);
  });

  it("drains down the rocks and decays to near zero before the next wave breaks", () => {
    const table = rocks("right");
    const s = createShoreScheduler(5);
    const foam = createFoamField(ASPECT);
    s.step(0, MAX_PERIOD);
    const first = s.waves[0];
    // Step until the first wave is done splatting everywhere.
    const splatEnd = T_STOP + 0.6 + first.peelSpan;
    let peak = 0;
    let centreAtEnd = 0;
    let centreLater = 0;
    const centre = () => {
      let m = 0;
      let my = 0;
      for (let r = 0; r < foam.rows; r++) {
        for (let c = 0; c < foam.columns; c++) {
          const d = foam.density[r * foam.columns + c];
          m += d;
          my += d * r;
        }
      }
      return m > 0 ? my / m : 0;
    };
    let nextBreak = Infinity;
    while (s.time < 40) {
      s.step(1 / 30, MAX_PERIOD);
      advanceFoam(foam, s, table, ASPECT, 0.5, 1 / 30);
      peak = Math.max(peak, maxFoam(foam));
      if (centreAtEnd === 0 && s.time >= splatEnd) centreAtEnd = centre();
      if (centreLater === 0 && s.time >= splatEnd + 1.5) centreLater = centre();
      if (s.spawned > 1 && nextBreak === Infinity) {
        const w = s.waves[s.count - 1];
        nextBreak = w.start + T_APPROACH - 0.25;
      }
      if (s.time >= nextBreak) break;
    }
    expect(peak).toBeGreaterThan(0.5);
    expect(centreLater).toBeLessThan(centreAtEnd);
    expect(Number.isFinite(nextBreak)).toBe(true);
    expect(maxFoam(foam)).toBeLessThan(0.05);
  });
});

describe("spray", () => {
  it("bursts at each break, stays within the pool and dies away", () => {
    const table = rocks("left");
    const s = createShoreScheduler(3);
    const spray = createSpray();
    const rand = createRng(1);
    const out = new Float32Array(MAX_SPRAY * SPRAY_FLOATS);
    let peak = 0;
    let badAlpha = 0;
    s.step(0, MAX_PERIOD);
    const w = s.waves[0];
    let beforeBreak = 0;
    for (let i = 0; i < 16 * 60; i++) {
      s.step(1 / 60, MAX_PERIOD);
      stepSpray(spray, s, table, ASPECT, 1, 1 / 60, rand);
      if (s.time < w.start + T_APPROACH - 0.05) beforeBreak = Math.max(beforeBreak, spray.count);
      peak = Math.max(peak, spray.count);
      const n = writeSpray(spray, out, 1080, 1);
      for (let k = 0; k < n; k++) {
        const a = out[k * SPRAY_FLOATS + 3];
        if (!(a >= 0 && a <= SPRAY_ALPHA)) badAlpha++;
      }
    }
    expect(beforeBreak).toBe(0);
    expect(peak).toBeGreaterThan(50);
    expect(peak).toBeLessThanOrEqual(MAX_SPRAY);
    expect(badAlpha).toBe(0);
    // Long after the break (and before the next wave), the spray has all fallen.
    expect(spray.count).toBe(0);
  });
});

describe("palettes", () => {
  it("has one per sky option and falls back to morning", () => {
    for (const { value } of SKY_OPTIONS) expect(paletteFor(value)).toBe(PALETTES[value]);
    expect(paletteFor("nope")).toBe(PALETTES.morning);
  });
});
