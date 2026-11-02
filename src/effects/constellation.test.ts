import { describe, expect, it } from "vitest";
import { buildGrid, createLinkGrid, findLinks, linkFalloff } from "./constellation";
import { createRng } from "./noise";
import { wrap } from "./math";

function bruteForce(xs: Float32Array, ys: Float32Array, n: number, maxDist: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = xs[j] - xs[i];
      const dy = ys[j] - ys[i];
      if (dx * dx + dy * dy < maxDist * maxDist) out.add(`${i},${j}`);
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
    pairs.push(`${i},${j}`);
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

describe("linkFalloff", () => {
  it("is (1 - t)² and zero beyond the link distance", () => {
    expect(linkFalloff(0)).toBe(1);
    expect(linkFalloff(0.5)).toBe(0.25);
    expect(linkFalloff(1)).toBe(0);
    expect(linkFalloff(1.5)).toBe(0);
  });
});

describe("grid neighbour search", () => {
  it("matches brute force on random data", () => {
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
      for (const pair of pairs) expect(expected.has(pair)).toBe(true);
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
    for (const pair of pairs) expect(expected.has(pair)).toBe(true);
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
