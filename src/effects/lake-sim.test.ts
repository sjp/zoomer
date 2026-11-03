import { describe, expect, it } from "vitest";
import {
  blendPalette,
  createRingState,
  EVERGREEN_KEY,
  fillTreeTable,
  HORIZON_GAP,
  MAX_RINGS,
  MAX_TREE,
  MIN_BACK,
  MIN_FRONT,
  packRings,
  PALETTE_FLOATS,
  RING_LIFE,
  RING_STRIDE,
  ringDepthRange,
  SEASON_PALETTES,
  seasonPalette,
  stepRings,
  toPlane,
  TREE_CHANNELS,
  TREE_COLUMNS,
  WIND_OFF,
  windGust,
  windMask,
  windSlope,
  windThreshold,
} from "./lake-sim";
import { SEASON_OPTIONS } from "./lake.meta";
import { createRng } from "./noise";

const table = (seed: number, aspect = 16 / 9) => {
  const t = new Float32Array(TREE_COLUMNS * TREE_CHANNELS);
  fillTreeTable(t, seed, aspect);
  return t;
};

describe("treeline table", () => {
  it("is deterministic per seed and differs between seeds", () => {
    expect(table(3)).toEqual(table(3));
    expect(table(3)).not.toEqual(table(4));
  });

  it("spans the full width at every aspect", () => {
    for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
      for (const seed of [0, 3, 999]) {
        const t = table(seed, aspect);
        let bad = 0;
        let crowned = 0;
        let evergreens = 0;
        for (let i = 0; i < TREE_COLUMNS; i++) {
          const o = i * TREE_CHANNELS;
          const [front, key, round, back] = [t[o], t[o + 1], t[o + 2], t[o + 3]];
          if (!(front >= MIN_FRONT && front <= MAX_TREE)) bad++;
          if (!(back >= MIN_BACK && back <= MAX_TREE)) bad++;
          if (!(round >= 0 && round <= 1)) bad++;
          if (!((key >= 0 && key <= 1) || key === EVERGREEN_KEY)) bad++;
          if (front > MIN_FRONT + 0.02) crowned++;
          if (key === EVERGREEN_KEY) evergreens++;
        }
        expect(bad).toBe(0);
        // Dense crowns everywhere, the edges included, with some evergreens mixed in.
        expect(crowned).toBeGreaterThan(TREE_COLUMNS * 0.95);
        expect(t[0]).toBeGreaterThan(MIN_FRONT + 0.02);
        expect(t[(TREE_COLUMNS - 1) * TREE_CHANNELS]).toBeGreaterThan(MIN_FRONT + 0.02);
        expect(evergreens).toBeGreaterThan(0);
        expect(evergreens).toBeLessThan(TREE_COLUMNS * 0.5);
      }
    }
  });

  it("falls back to 16:9 for a bad aspect", () => {
    expect(table(5, Number.NaN)).toEqual(table(5, 16 / 9));
  });
});

describe("palettes", () => {
  it("has a full palette of unit colours for every season", () => {
    for (const { value } of SEASON_OPTIONS) {
      const p = SEASON_PALETTES[value];
      expect(p.length).toBe(PALETTE_FLOATS);
      expect(p.every((c) => c >= 0 && c <= 1)).toBe(true);
      expect(seasonPalette(value)).toBe(p);
    }
    expect(seasonPalette("bogus")).toBe(SEASON_PALETTES.peak);
  });

  it("fades towards the target and stops there", () => {
    const cur = SEASON_PALETTES.summer.slice();
    const goal = SEASON_PALETTES.peak;
    let steps = 0;
    while (blendPalette(cur, goal, 0.05) && steps < 100) steps++;
    expect(steps).toBeGreaterThan(1);
    expect(steps).toBeLessThan(25);
    expect(cur).toEqual(goal);
    expect(blendPalette(cur, goal, 0.05)).toBe(false);
  });
});

describe("water plane", () => {
  it("puts the shoreline at the horizon gap and nearer water lower in the frame", () => {
    const a: [number, number] = [0, 0];
    const b: [number, number] = [0, 0];
    toPlane(0.5, 0.45, 0.45, 16 / 9, a);
    expect(a[1]).toBeCloseTo(1 / HORIZON_GAP);
    expect(a[0]).toBe(0);
    toPlane(0.9, 0, 0.45, 16 / 9, b);
    expect(b[1]).toBeLessThan(a[1]);
    expect(b[0]).toBeCloseTo(0.4 * (16 / 9) * b[1]);
  });
});

describe("ripple rings", () => {
  const packed = new Float32Array(MAX_RINGS * RING_STRIDE);

  it("spawns at the requested rate", () => {
    const rng = createRng(1);
    const s = createRingState(rng);
    for (let i = 0; i < 3600 * 10; i++) stepRings(s, 0.1, 10, rng);
    // One hour at 10 a minute: 600 expected, sd about 25.
    expect(s.spawned).toBeGreaterThan(520);
    expect(s.spawned).toBeLessThan(680);
  });

  it("spawns nothing at rate 0 or with bad input", () => {
    const rng = createRng(2);
    const s = createRingState(rng);
    for (let i = 0; i < 600; i++) stepRings(s, 0.1, 0, rng);
    stepRings(s, 0.1, Number.NaN, rng);
    stepRings(s, Number.NaN, 10, rng);
    expect(s.spawned).toBe(0);
    expect(packRings(packed, s, 0.45, 16 / 9)).toBe(0);
  });

  it("expires rings and never overflows the uniform array", () => {
    const rng = createRng(3);
    const s = createRingState(rng);
    let maxCount = 0;
    let bad = 0;
    const small = new Float32Array(2 * RING_STRIDE + 3);
    for (let i = 0; i < 2000; i++) {
      stepRings(s, 1 / 30, 600, rng);
      const n = packRings(packed, s, 0.45, 16 / 9);
      maxCount = Math.max(maxCount, n);
      for (let j = 0; j < n * RING_STRIDE; j++) if (!Number.isFinite(packed[j])) bad++;
      if (packRings(small, s, 0.45, 16 / 9) > 2) bad++;
    }
    expect(bad).toBe(0);
    expect(maxCount).toBe(MAX_RINGS);
    // With no new rings, every ring is gone after its lifespan.
    for (let i = 0; i < (RING_LIFE + 0.5) * 30; i++) stepRings(s, 1 / 30, 0, rng);
    expect(packRings(packed, s, 0.45, 16 / 9)).toBe(0);
  });

  it("places rings on the visible water", () => {
    const rng = createRng(4);
    const s = createRingState(rng);
    const range: [number, number] = [0, 0];
    let bad = 0;
    for (const shore of [0.3, 0.45, 0.6]) {
      ringDepthRange(shore, range);
      for (let i = 0; i < 600; i++) {
        stepRings(s, 0.5, 60, rng);
        const n = packRings(packed, s, shore, 16 / 9);
        for (let j = 0; j < n; j++) {
          const x = packed[j * RING_STRIDE];
          const z = packed[j * RING_STRIDE + 1];
          // Back on screen: y = shore + gap - 1 / Z, u = 0.5 + X / (Z · aspect).
          const y = shore + HORIZON_GAP - 1 / z;
          const u = 0.5 + x / (z * (16 / 9));
          if (!(y > 0 && y < shore && u > 0 && u < 1)) bad++;
          if (z < range[0] - 1e-5 || z > range[1] + 1e-5) bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });
});

describe("wind", () => {
  it("keeps the mask in [0, 1]", () => {
    const rng = createRng(5);
    let bad = 0;
    for (let i = 0; i < 5000; i++) {
      const thr = windThreshold(rng() * 1.4 - 0.2, rng() * 1e4);
      const m = windMask(rng() * 3 - 1, thr);
      if (!(m >= 0 && m <= 1)) bad++;
    }
    for (const n of [Number.NaN, Infinity, -Infinity]) {
      const m = windMask(n, 0.5);
      if (!(m >= 0 && m <= 1)) bad++;
    }
    expect(bad).toBe(0);
  });

  it("calms the water without wind and ruffles more of it with more", () => {
    expect(windThreshold(0, 10)).toBe(WIND_OFF);
    expect(windMask(1, windThreshold(0, 10))).toBe(0);
    let bad = 0;
    for (let t = 0; t < 2000; t += 0.7) {
      const g = windGust(t);
      if (!(g >= 0 && g <= 1)) bad++;
      if (!(windThreshold(1, t) < windThreshold(0.4, t))) bad++;
      if (!(windThreshold(0.4, t) < windThreshold(0.1, t))) bad++;
    }
    expect(bad).toBe(0);
    expect(windSlope(1)).toBeGreaterThan(windSlope(0));
  });
});
