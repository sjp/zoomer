import { describe, expect, it } from "vitest";
import {
  buildGrid,
  createLinkGrid,
  driftPoint,
  findLinks,
  linkFalloff,
  type LinkFilter,
} from "./constellation";
import { createRng } from "../noise";
import { wrap } from "../math";

function bruteForce(xs: Float32Array, ys: Float32Array, n: number, maxDist: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = xs[j] - xs[i];
      const dy = ys[j] - ys[i];
      if (dx * dx + dy * dy < maxDist * maxDist) {
        out.add(`${String(i)},${String(j)}`);
      }
    }
  }
  return out;
}

function gridLinks(
  xs: Float32Array,
  ys: Float32Array,
  n: number,
  minX: number,
  minY: number,
  spanX: number,
  spanY: number,
  maxDist: number,
  cap: number,
) {
  const grid = createLinkGrid(n);
  buildGrid(grid, xs, ys, n, minX, minY, spanX, spanY, maxDist);
  const a = new Int32Array(cap);
  const b = new Int32Array(cap);
  const t = new Float32Array(cap);
  const count = findLinks(grid, xs, ys, maxDist, a, b, t, cap);
  const pairs: string[] = [];
  for (let l = 0; l < count; l++) {
    const i = Math.min(a[l], b[l]);
    const j = Math.max(a[l], b[l]);
    pairs.push(`${String(i)},${String(j)}`);
    const d = Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);
    expect(t[l]).toBeCloseTo(d / maxDist, 5);
  }
  return { count, pairs };
}

function randomPoints(seed: number, n: number, minX: number, minY: number, w: number, h: number) {
  const rng = createRng(seed);
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = wrap(minX + rng() * w, minX, w);
    ys[i] = wrap(minY + rng() * h, minY, h);
  }
  return { xs, ys };
}

describe("driftPoint", () => {
  it("moves without wrapping inside the domain", () => {
    const xs = new Float32Array([100]);
    const ys = new Float32Array([200]);
    expect(driftPoint(xs, ys, 0, 1.5, -2, -50, -50, 2020, 1180)).toBe(false);
    expect(xs[0]).toBeCloseTo(101.5, 4);
    expect(ys[0]).toBeCloseTo(198, 4);
  });

  it("flags a wrap on either axis", () => {
    const xs = new Float32Array([1969, 10]);
    const ys = new Float32Array([500, -49]);
    expect(driftPoint(xs, ys, 0, 2, 0, -50, -50, 2020, 1180)).toBe(true);
    expect(xs[0]).toBeCloseTo(-49, 3);
    expect(driftPoint(xs, ys, 1, 0, -2, -50, -50, 2020, 1180)).toBe(true);
    expect(ys[1]).toBeCloseTo(1129, 3);
  });

  it("flags the fold when the link distance shrinks the margin", () => {
    // From 0.3 to 0.05 of the height: x = 2200 was in the old margin.
    const dist = 0.05 * 1080;
    const xs = new Float32Array([2200]);
    const ys = new Float32Array([500]);
    expect(driftPoint(xs, ys, 0, 0, 0, -dist, -dist, 1920 + 2 * dist, 1080 + 2 * dist)).toBe(true);
    expect(xs[0]).toBeGreaterThan(0);
    expect(xs[0]).toBeLessThan(1920);
  });
});

describe("driftPoint wrapping", () => {
  it("wraps a point stored exactly at minX + spanX to minX, flagging it", () => {
    const xs = new Float32Array([1970, 300]);
    const ys = new Float32Array([500, 1130]);
    expect(driftPoint(xs, ys, 0, 0, 0, -50, -50, 2020, 1180)).toBe(true);
    expect(xs[0]).toBe(-50);
    expect(driftPoint(xs, ys, 1, 0, 0, -50, -50, 2020, 1180)).toBe(true);
    expect(ys[1]).toBe(-50);
    // ...and a point exactly at minX stays.
    expect(driftPoint(xs, ys, 0, 0, 0, -50, -50, 2020, 1180)).toBe(false);
    expect(xs[0]).toBe(-50);
  });

  it("keeps drifting points in the domain, flagging each crossing once", () => {
    const rng = createRng(31);
    for (let k = 0; k < 20; k++) {
      // Awkward, non-representable domains and steps.
      const minX = -40 - rng() * 30;
      const minY = -40 - rng() * 30;
      const spanX = 1920 - 2 * minX;
      const spanY = 1080 - 2 * minY;
      const dx = (rng() - 0.5) * 7;
      const dy = (rng() - 0.5) * 7;
      const xs = new Float32Array([rng() * 1920]);
      const ys = new Float32Array([rng() * 1080]);
      // Float32 storage may round a point up onto the far edge, never past it.
      const loX = Math.fround(minX);
      const hiX = Math.fround(minX + spanX);
      const loY = Math.fround(minY);
      const hiY = Math.fround(minY + spanY);
      let flagged = 0;
      let crossings = 0;
      // Plain comparisons in the hot loop: an expect per step dominates the runtime.
      const outside: string[] = [];
      for (let step = 0; step < 5000; step++) {
        const x = xs[0] + dx;
        const y = ys[0] + dy;
        if (x < minX || x >= minX + spanX || y < minY || y >= minY + spanY) {
          crossings++;
        }
        if (driftPoint(xs, ys, 0, dx, dy, minX, minY, spanX, spanY)) {
          flagged++;
        }
        const inside = xs[0] >= loX && xs[0] <= hiX && ys[0] >= loY && ys[0] <= hiY;
        if (!inside && outside.length < 10) {
          outside.push(
            `domain ${String(k)}, step ${String(step)}: (${String(xs[0])}, ${String(ys[0])})`,
          );
        }
      }
      expect(outside).toEqual([]);
      expect(flagged).toBe(crossings);
      expect(crossings).toBeGreaterThan(0);
    }
  });

  it("bins a point on the far edge into the last cell", () => {
    const grid = createLinkGrid(4);
    const xs = new Float32Array([1970, -50, 960, 1970]);
    const ys = new Float32Array([1130, -50, 540, -50]);
    buildGrid(grid, xs, ys, 4, -50, -50, 2020, 1180, 100);
    expect(grid.cellOf[0]).toBe(grid.cols * grid.rows - 1);
    expect(grid.cellOf[1]).toBe(0);
    expect(grid.cellOf[3]).toBe(grid.cols - 1);
  });
});

describe("linkFalloff", () => {
  it("is (1 - t)² and zero beyond the link distance", () => {
    expect(linkFalloff(0)).toBe(1);
    expect(linkFalloff(0.5)).toBe(0.25);
    expect(linkFalloff(1)).toBe(0);
    expect(linkFalloff(1.5)).toBe(0);
  });
});

describe("grid neighbour search", () => {
  // Twenty brute-force searches over up to 390 points: the cost is the search itself.
  it("matches brute force on random data", { timeout: 20_000 }, () => {
    for (let seed = 1; seed <= 20; seed++) {
      const n = 50 + seed * 17;
      const maxDist = 40 + seed * 9;
      // Domain includes the off-screen margin of one link distance.
      const minX = -maxDist;
      const minY = -maxDist;
      const spanX = 1920 + 2 * maxDist;
      const spanY = 1080 + 2 * maxDist;
      const { xs, ys } = randomPoints(seed, n, minX, minY, spanX, spanY);
      const { count, pairs } = gridLinks(xs, ys, n, minX, minY, spanX, spanY, maxDist, 1e6);
      const expected = bruteForce(xs, ys, n, maxDist);
      expect(count).toBe(expected.size);
      expect(new Set(pairs).size).toBe(count);
      expect(pairs.filter((pair) => !expected.has(pair)).slice(0, 10)).toEqual([]);
    }
  });

  it("finds links between points in the wrap margins and across cell borders", () => {
    const maxDist = 100;
    const minX = -100;
    const minY = -100;
    const spanX = 500;
    const spanY = 400;
    // Corners of the margin, the last partial cell, and pairs straddling cell edges.
    const pts = [
      [-100, -100],
      [-50, -60],
      [399.99, 299.99],
      [340, 260],
      [-0.01, 50],
      [0.01, 50],
      [199, -100],
      [201, -99],
      [wrap(400, minX, spanX), 0], // wraps to the left margin edge
    ];
    const n = pts.length;
    const xs = new Float32Array(pts.map((p) => p[0]));
    const ys = new Float32Array(pts.map((p) => p[1]));
    const { count, pairs } = gridLinks(xs, ys, n, minX, minY, spanX, spanY, maxDist, 1000);
    const expected = bruteForce(xs, ys, n, maxDist);
    expect(count).toBe(expected.size);
    expect(new Set(pairs)).toEqual(expected);
    expect(expected.has("0,1")).toBe(true);
    expect(expected.has("2,3")).toBe(true);
    expect(expected.has("4,5")).toBe(true);
    expect(expected.has("6,7")).toBe(true);
  });

  it("stops at the capacity cap with valid, distinct links", () => {
    const n = 400;
    const maxDist = 300;
    const minX = -maxDist;
    const minY = -maxDist;
    const spanX = 1920 + 2 * maxDist;
    const spanY = 1080 + 2 * maxDist;
    const { xs, ys } = randomPoints(99, n, minX, minY, spanX, spanY);
    const expected = bruteForce(xs, ys, n, maxDist);
    const cap = 500;
    expect(expected.size).toBeGreaterThan(cap);
    const { count, pairs } = gridLinks(xs, ys, n, minX, minY, spanX, spanY, maxDist, cap);
    expect(count).toBe(cap);
    expect(new Set(pairs).size).toBe(cap);
    for (const pair of pairs) {
      expect(expected.has(pair)).toBe(true);
    }
  });

  it("reuses a grid across rebuilds of different sizes", () => {
    const grid = createLinkGrid(100);
    const a = new Int32Array(10000);
    const b = new Int32Array(10000);
    const t = new Float32Array(10000);
    for (const maxDist of [200, 30, 120]) {
      const { xs, ys } = randomPoints(maxDist, 100, -maxDist, -maxDist, 1000, 600);
      buildGrid(grid, xs, ys, 100, -maxDist, -maxDist, 1000, 600, maxDist);
      const count = findLinks(grid, xs, ys, maxDist, a, b, t, 10000);
      expect(count).toBe(bruteForce(xs, ys, 100, maxDist).size);
    }
  });

  it("handles no points", () => {
    const grid = createLinkGrid(4);
    const xs = new Float32Array(4);
    buildGrid(grid, xs, xs, 0, 0, 0, 100, 100, 10);
    expect(
      findLinks(grid, xs, xs, 10, new Int32Array(1), new Int32Array(1), new Float32Array(1), 1),
    ).toBe(0);
  });
});

describe("findLinks filter", () => {
  /** Links among the given points, as sorted "i,j" pairs. */
  const linksOf = (pts: number[][], maxDist: number, filter: LinkFilter, cap = 100) => {
    const n = pts.length;
    const xs = new Float32Array(pts.map((p) => p[0]));
    const ys = new Float32Array(pts.map((p) => p[1]));
    const grid = createLinkGrid(n);
    buildGrid(grid, xs, ys, n, -maxDist, -maxDist, 100 + 2 * maxDist, 100 + 2 * maxDist, maxDist);
    const a = new Int32Array(cap);
    const b = new Int32Array(cap);
    const t = new Float32Array(cap);
    const count = findLinks(grid, xs, ys, maxDist, a, b, t, cap, filter);
    const out: string[] = [];
    for (let l = 0; l < count; l++) {
      out.push(`${String(Math.min(a[l], b[l]))},${String(Math.max(a[l], b[l]))}`);
    }
    return { pairs: out.toSorted(), t: t.slice(0, count) };
  };
  const view = (over: Partial<LinkFilter> = {}): LinkFilter => ({
    minX: 0,
    minY: 0,
    maxX: 100,
    maxY: 100,
    reach: 1,
    weight: null,
    ...over,
  });

  it("skips links wholly beyond one edge of the view", () => {
    const pts = [
      [-15, 50], // 0: left margin
      [-5, 58], //  1: left margin
      [5, 50], //   2: on screen
      [50, -5], //  3: top margin
      [58, -15], // 4: top margin
      [-5, 5], //   5: left margin
      [5, -5], //   6: top margin
    ];
    // 0-1 and 3-4 can't cross the screen. 0-2 and 1-2 end on it, and 5-6 cuts
    // the corner between points beyond different edges, so they stay.
    expect(linksOf(pts, 25, view()).pairs).toEqual(["0,2", "1,2", "5,6"]);
  });

  it("finds every link without a filter", () => {
    const pts = [
      [-15, 50],
      [-5, 58],
      [5, 50],
    ];
    const n = pts.length;
    const xs = new Float32Array(pts.map((p) => p[0]));
    const ys = new Float32Array(pts.map((p) => p[1]));
    expect(gridLinks(xs, ys, n, -25, -25, 150, 150, 25, 10).count).toBe(3);
  });

  it("skips links to points with no weight", () => {
    const pts = [
      [10, 10],
      [15, 10],
      [20, 10],
    ];
    const weight = new Float32Array([1, 0, 0.5]);
    expect(linksOf(pts, 20, view({ weight })).pairs).toEqual(["0,2"]);
  });

  it("limits links to `reach` times the distance, keeping t relative to it", () => {
    const pts = [
      [10, 10],
      [15, 10],
      [28, 10],
    ];
    const { pairs, t } = linksOf(pts, 20, view({ reach: 0.7 }));
    expect(pairs).toEqual(["0,1", "1,2"]);
    const ts = [...t].toSorted((a, b) => a - b);
    expect(ts[0]).toBeCloseTo(0.25, 6);
    expect(ts[1]).toBeCloseTo(0.65, 6);
    expect(linksOf(pts, 20, view({ reach: 0 })).pairs).toEqual([]);
  });

  it("leaves the cap to visible links", () => {
    // Many pairs far off to the left, then one on screen: the cap still finds it.
    const pts: number[][] = [];
    for (let i = 0; i < 10; i++) {
      pts.push([-15 + i * 0.5, 50]);
    }
    pts.push([40, 50], [45, 50]);
    expect(linksOf(pts, 20, view(), 1).pairs).toEqual(["10,11"]);
  });
});
