import { describe, expect, it } from "vitest";
import { createRng } from "./noise";
import {
  createVoronoiSample,
  SEARCH_BOUND,
  type VoronoiOffset,
  voronoiHash,
  voronoiSample,
} from "./voronoi";

/** Offsets filling the whole search bound: a point in the disc of radius SEARCH_BOUND. */
const fullOffset: VoronoiOffset = (h, _ix, _iy, out) => {
  const a = ((h & 0xffff) / 0x10000) * 2 * Math.PI;
  const r = SEARCH_BOUND * Math.sqrt((h >>> 16) / 0x10000);
  out[0] = r * Math.cos(a);
  out[1] = r * Math.sin(a);
  return out;
};

describe("voronoiSample", () => {
  it("3x3 search matches a 7x7 brute force with offsets at the search bound", () => {
    const rng = createRng(94);
    const a = createVoronoiSample();
    const b = createVoronoiSample();
    let bad = 0;
    for (let n = 0; n < 3000; n++) {
      const gx = 1000 + rng() * 30;
      const gy = 1000 + rng() * 30;
      voronoiSample(gx, gy, fullOffset, a, 1);
      voronoiSample(gx, gy, fullOffset, b, 3);
      if (a.hash !== b.hash || Math.abs(a.f1 - b.f1) > 1e-12 || Math.abs(a.f2 - b.f2) > 1e-12) {
        bad++;
      }
      // The edge is exact near it, where effects draw lines.
      if (b.edge < 0.2 && (Math.abs(a.edge - b.edge) > 1e-12 || a.edgeHash !== b.edgeHash)) bad++;
    }
    expect(bad).toBe(0);
  });

  it("the edge neighbour is the cell across the nearest edge", () => {
    const v = createVoronoiSample();
    const a = [0, 0];
    const b = [0, 0];
    let bad = 0;
    let checked = 0;
    for (let iy = 1000; iy < 1030; iy++) {
      for (let ix = 1000; ix < 1030; ix++) {
        // Just on seed A's side of the midpoint between A and its right-hand neighbour B.
        fullOffset(voronoiHash(ix, iy), ix, iy, a);
        fullOffset(voronoiHash(ix + 1, iy), ix + 1, iy, b);
        const ax = ix + 0.5 + a[0];
        const ay = iy + 0.5 + a[1];
        const bx = ix + 1.5 + b[0];
        const by = iy + 0.5 + b[1];
        voronoiSample(0.51 * ax + 0.49 * bx, 0.51 * ay + 0.49 * by, fullOffset, v);
        // Skip points where another seed is nearer, or another edge is as near.
        const d = 0.01 * Math.hypot(bx - ax, by - ay);
        if (v.hash !== voronoiHash(ix, iy) || Math.abs(v.edge - d) > 1e-9) continue;
        checked++;
        if (v.edgeHash !== voronoiHash(ix + 1, iy)) bad++;
      }
    }
    expect(checked).toBeGreaterThan(600);
    expect(bad).toBe(0);
  });

  it("returns the nearest and second-nearest bisectors with their unit normals", () => {
    const rng = createRng(115);
    const v = createVoronoiSample();
    const o = [0, 0];
    let bad = 0;
    for (let n = 0; n < 2000; n++) {
      const gx = 1000 + rng() * 30;
      const gy = 1000 + rng() * 30;
      voronoiSample(gx, gy, fullOffset, v);
      // Brute force over the same 3x3 block: the two smallest bisector distances.
      const cx = Math.floor(gx);
      const cy = Math.floor(gy);
      let sx = 0;
      let sy = 0;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          if (voronoiHash(cx + i, cy + j) !== v.hash) continue;
          fullOffset(v.hash, cx + i, cy + j, o);
          sx = cx + i + 0.5 + o[0];
          sy = cy + j + 0.5 + o[1];
        }
      }
      const d: number[] = [];
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          fullOffset(voronoiHash(cx + i, cy + j), cx + i, cy + j, o);
          const bx = cx + i + 0.5 + o[0];
          const by = cy + j + 0.5 + o[1];
          if (bx === sx && by === sy) continue;
          const len = Math.hypot(bx - sx, by - sy);
          // Distance from g to the bisector, toward the neighbour.
          d.push(((bx - sx) * (0.5 * (sx + bx) - gx) + (by - sy) * (0.5 * (sy + by) - gy)) / len);
        }
      }
      d.sort((a, b) => a - b);
      if (Math.abs(v.edge - d[0]) > 1e-9 || Math.abs(v.edge2 - d[1]) > 1e-9) bad++;
      if (Math.abs(Math.hypot(v.nx, v.ny) - 1) > 1e-12) bad++;
      if (Math.abs(Math.hypot(v.n2x, v.n2y) - 1) > 1e-12) bad++;
      // The normals point from g's seed to the bisector: g plus edge times normal lies on it.
      const ex = gx + v.edge * v.nx;
      const ey = gy + v.edge * v.ny;
      if (Math.abs(voronoiSample(ex, ey, fullOffset, createVoronoiSample()).edge) > 1e-9) bad++;
    }
    expect(bad).toBe(0);
  });
});
