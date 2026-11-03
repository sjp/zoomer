import { describe, expect, it } from "vitest";
import {
  buildForeground,
  createLoneTree,
  FG_COLUMNS,
  maxSectors,
  polePosition,
  PROFILE_MAX,
  SECTORS_CHECKED,
  tailProfile,
  trailsAt,
  trailsAtBruteForce,
  TREE_BLOBS,
} from "./startrails-sim";
import { DEG, sectorCount, seedSalt, TAU } from "./starfield-sim";
import { buildHills, HILL_COLUMNS, hillHeightAt } from "./horizon-sim";
import { createRng } from "./noise";
import { TRAIL_LENGTH_MAX, TRAIL_LENGTH_MIN } from "./startrails.meta";
import { MAX_LAYERS, MIN_LAYERS } from "./horizon.meta";

const LENGTHS = [TRAIL_LENGTH_MIN, 12, 40, 90, 133, TRAIL_LENGTH_MAX].map((d) => d * DEG);

describe("sector counts", () => {
  it("are at least 1, grow away from the pole and respect the cap", () => {
    for (const len of LENGTHS) {
      const cap = maxSectors(len);
      expect(cap).toBeGreaterThanOrEqual(1);
      let prev = 0;
      let ok = true;
      for (let ring = 0; ring < 400; ring++) {
        const n = sectorCount(ring, cap);
        // Sectors are wide enough that a trail spans at most SECTORS_CHECKED of them.
        ok &&= n >= 1 && n <= cap && n >= prev && Math.ceil(len / (TAU / n)) + 1 <= SECTORS_CHECKED;
        prev = n;
      }
      expect(ok).toBe(true);
    }
    expect(sectorCount(0, maxSectors(5 * DEG))).toBe(1);
    expect(sectorCount(0, 0)).toBe(1);
  });

  it("let the bounded loop find every trail the brute force finds", () => {
    const rand = createRng(99);
    for (const len of LENGTHS) {
      for (const comet of [false, true]) {
        const s = { length: len, density: 0.8, salt: seedSalt(5), comet };
        let lit = 0;
        let maxDiff = 0;
        for (let i = 0; i < 800; i++) {
          // Bias towards the pole, where rings have few sectors.
          const r = i < 200 ? rand() * 40 : rand() * 2500;
          const phi = rand() * TAU;
          const fast = trailsAt(r, phi, s);
          maxDiff = Math.max(maxDiff, Math.abs(fast - trailsAtBruteForce(r, phi, s)));
          if (fast > 0) lit++;
        }
        expect(maxDiff).toBeLessThan(1e-9);
        expect(lit).toBeGreaterThan(10);
      }
    }
  });

  it("are continuous across the angle seam at 0 / 2π", () => {
    const s = { length: 60 * DEG, density: 1, salt: seedSalt(2), comet: false };
    for (let r = 3; r < 2000; r += 1.37) {
      expect(trailsAt(r, TAU - 1e-9, s)).toBeCloseTo(trailsAt(r, 0, s), 4);
    }
  });
});

describe("tail profile", () => {
  it("is 0 outside [0, L] and bounded", () => {
    for (const len of LENGTHS) {
      for (const comet of [false, true]) {
        expect(tailProfile(-0.01, len, 300, comet)).toBe(0);
        expect(tailProfile(0, len, 300, comet)).toBe(0);
        expect(tailProfile(len, len, 300, comet)).toBe(0);
        expect(tailProfile(len + 0.01, len, 300, comet)).toBe(0);
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i <= 1000; i++) {
          const v = tailProfile((i / 1000) * len, len, 300, comet);
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
        expect(min).toBeGreaterThanOrEqual(0);
        expect(max).toBeLessThanOrEqual(PROFILE_MAX);
      }
    }
  });

  it("is continuous, including at both ends", () => {
    for (const radius of [2, 40, 900]) {
      for (const comet of [false, true]) {
        const len = 30 * DEG;
        const steps = 20000;
        const lo = -0.1 * len;
        const span = 1.2 * len;
        // Largest jump per step is bounded by the steepest slope: the end taper.
        const maxSlope = (1.5 / 1.5) * radius * PROFILE_MAX * 2;
        const h = span / steps;
        let prev = tailProfile(lo, len, radius, comet);
        let maxJump = 0;
        for (let i = 1; i <= steps; i++) {
          const v = tailProfile(lo + i * h, len, radius, comet);
          maxJump = Math.max(maxJump, Math.abs(v - prev));
          prev = v;
        }
        expect(maxJump).toBeLessThanOrEqual(maxSlope * h + 1e-9);
      }
    }
  });

  it("is uniform in photo style and fades towards the tail in comet style", () => {
    const len = 40 * DEG;
    expect(tailProfile(0.3 * len, len, 500, false)).toBeCloseTo(1, 9);
    expect(tailProfile(0.7 * len, len, 500, false)).toBeCloseTo(1, 9);
    const head = tailProfile(0.01 * len, len, 500, true);
    const mid = tailProfile(0.5 * len, len, 500, true);
    const tail = tailProfile(0.95 * len, len, 500, true);
    expect(head).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(tail);
  });
});

describe("pole", () => {
  it("places each option, falling back to top right", () => {
    const out: [number, number] = [0, 0];
    expect(polePosition("topLeft", 1920, out)[0]).toBeLessThan(960);
    expect(polePosition("topRight", 1920, out)[0]).toBeGreaterThan(960);
    expect(polePosition("above", 1920, out)[1]).toBeGreaterThan(1080);
    expect(polePosition("centre", 1920, out)).toEqual([960, 648]);
    expect(polePosition("bogus", 1920, out)).toEqual(polePosition("topRight", 1920, [0, 0]));
  });
});

describe("foreground", () => {
  it("is deterministic, in range, and empty for none", () => {
    for (const kind of ["treeline", "mountains", "tree"]) {
      const a = new Float32Array(FG_COLUMNS);
      const b = new Float32Array(FG_COLUMNS);
      buildForeground(a, kind, 4, 1920, createLoneTree());
      buildForeground(b, kind, 4, 1920, createLoneTree());
      expect(b).toEqual(a);
      expect(Math.min(...a)).toBeGreaterThan(0.02);
      expect(Math.max(...a)).toBeLessThan(0.45);
    }
    const none = new Float32Array(FG_COLUMNS).fill(1);
    expect(buildForeground(none, "none", 4, 1920, createLoneTree())).toBe(false);
    expect(none.every((h) => h === 0)).toBe(true);
  });

  it("builds a lone tree off to one side, within its box", () => {
    const out = new Float32Array(FG_COLUMNS);
    const tree = createLoneTree();
    expect(buildForeground(out, "tree", 11, 1920, tree)).toBe(true);
    const [x0, y0, x1, y1] = tree.box;
    expect(Math.abs((x0 + x1) / 2 / 1920 - 0.5)).toBeGreaterThan(0.2);
    for (let i = 0; i < TREE_BLOBS; i++) {
      const [x, y, r] = tree.blobs.subarray(i * 3, i * 3 + 3);
      expect(r).toBeGreaterThan(0);
      expect(x - r).toBeGreaterThanOrEqual(x0);
      expect(x + r).toBeLessThanOrEqual(x1);
      expect(y + r).toBeLessThanOrEqual(y1);
    }
    expect(tree.trunk[1]).toBeGreaterThanOrEqual(y0);
    expect(tree.trunk[2]).toBeGreaterThan(tree.trunk[1]);
  });

  it("raises the treeline above the bare ground", () => {
    const trees = new Float32Array(FG_COLUMNS);
    buildForeground(trees, "treeline", 4, 1920, createLoneTree());
    const profiles = new Float32Array(MAX_LAYERS * HILL_COLUMNS);
    const lo = new Float64Array(MAX_LAYERS);
    buildHills(profiles, MIN_LAYERS, 4, { amp: 0.5, ridge: 0, freq: 0.7 }, lo, lo.slice());
    let above = 0;
    let below = 0;
    for (let c = 0; c < FG_COLUMNS; c++) {
      const bare = hillHeightAt(profiles, MIN_LAYERS - 1, c / (FG_COLUMNS - 1)) - 0.04;
      below = Math.min(below, trees[c] - bare);
      if (trees[c] > bare + 10 / 1080) above++;
    }
    expect(below).toBeGreaterThan(-1e-6);
    expect(above).toBeGreaterThan(FG_COLUMNS * 0.4);
  });
});
