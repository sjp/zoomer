/**
 * Jittered Voronoi cells, shared by the effects that draw them (stained glass, lava
 * field): a GLSL lookup over the 3x3 cells around a grid point, and its JS twin
 * for tests and CPU-side checks.
 *
 * Grid space: one unit per cell. Cell (ix, iy) owns one seed at its centre
 * `(ix + 0.5, iy + 0.5)` plus an offset that each effect computes from the cell's
 * hash (`voronoiHash`). The lookup is exact (nearest seed, and distance to its
 * cell's boundary) while every offset stays within `SEARCH_BOUND` of the centre.
 */
import { hash32 } from "./noise";

/**
 * Largest offset of a seed from its cell centre for which a 3x3 search still finds
 * the nearest and second-nearest seeds exactly. For a point in cell (0, 0), every
 * seed outside the 3x3 block is at least `1.5 - R` away along one axis, while the
 * second-nearest of the 3x3 cell centres is at most `sqrt(1/2)` away (the worst
 * case being a cell corner, where four centres are that close), so F2 is at most
 * `sqrt(1/2) + R`. The search is exact when `sqrt(1/2) + R <= 1.5 - R`. The tests
 * check the bound numerically against a brute-force search.
 */
export const SEARCH_BOUND = (1.5 - Math.SQRT1_2) / 2;

/**
 * Seed hash of cell (ix, iy): the same bits as the shader's `voronoiHash`. The key
 * packs x and y into 12 bits each, so the pattern repeats every 4096 cells.
 */
export function voronoiHash(ix: number, iy: number): number {
  return hash32((ix & 0xfff) | ((iy & 0xfff) << 12));
}

/**
 * GLSL for `VoronoiCell voronoiCell(vec2 g)`: the nearest seed to grid point `g`
 * among the 3x3 cells around it, and the exact distance to that seed's cell
 * boundary (the nearest bisector with any other searched seed), plus the
 * second-nearest bisector (for facets that meet along the cell's medial axis).
 *
 * Needs `HASH32_GLSL` before it, and the including shader must define, also before
 * it, `vec2 voronoiOffset(uint h)`: the offset from its cell centre of the seed of
 * the cell with hash `h` (`voronoiHash`), at most `SEARCH_BOUND` long. `g` must be
 * non-negative (cell indices are converted to `uvec2`), so add an origin to grid
 * coordinates that could go below zero.
 *
 * Cost: nine hashes and offsets, nine squared distances, then eight bisector
 * distances with one `inversesqrt` each. Unused fields compile away.
 */
export const VORONOI_GLSL = /* glsl */ `
struct VoronoiCell {
  /** Nearest seed, in grid units. */
  vec2 seed;
  /** Squared distance from g to that seed. */
  float f1;
  /** Distance from g to the seed's cell boundary, in grid units. */
  float edge;
  /** Unit vector from the seed toward the neighbour across the nearest edge. */
  vec2 normal;
  /** Distance to the second-nearest bisector, and its unit vector (as normal). */
  float edge2;
  vec2 normal2;
  /** voronoiHash of the nearest seed's cell, and of the neighbour across the nearest edge. */
  uint hash;
  uint edgeHash;
};
uint voronoiHash(uvec2 c) {
  return hash32((c.x & 0xfffu) | ((c.y & 0xfffu) << 12));
}
VoronoiCell voronoiCell(vec2 g) {
  vec2 cell = floor(g);
  uvec2 ci = uvec2(cell);

  vec2 seeds[9];
  uint hashes[9];
  int best = 0;
  float f1 = 1e9;
  for (int j = 0; j < 3; j++) {
    for (int i = 0; i < 3; i++) {
      uint h = voronoiHash(ci + uvec2(i, j) - 1u);
      vec2 s = cell + vec2(float(i), float(j)) - 0.5 + voronoiOffset(h);
      int k = j * 3 + i;
      seeds[k] = s;
      hashes[k] = h;
      vec2 d = g - s;
      float dd = dot(d, d);
      if (dd < f1) {
        f1 = dd;
        best = k;
      }
    }
  }

  VoronoiCell v;
  v.seed = seeds[best];
  v.f1 = f1;
  v.hash = hashes[best];
  v.edge = 1e9;
  v.normal = vec2(0.0, 1.0);
  v.edge2 = 1e9;
  v.normal2 = vec2(0.0, -1.0);
  v.edgeHash = 0u;
  for (int k = 0; k < 9; k++) {
    if (k == best) continue;
    vec2 ab = seeds[k] - v.seed;
    vec2 d = g - seeds[k];
    float inv = inversesqrt(dot(ab, ab));
    float e = (dot(d, d) - f1) * 0.5 * inv;
    if (e < v.edge) {
      v.edge2 = v.edge;
      v.normal2 = v.normal;
      v.edge = e;
      v.normal = ab * inv;
      v.edgeHash = hashes[k];
    } else if (e < v.edge2) {
      v.edge2 = e;
      v.normal2 = ab * inv;
    }
  }
  return v;
}
`;

export interface VoronoiSample {
  /** Hash of the nearest seed (`voronoiHash`). */
  hash: number;
  /** Nearest and second-nearest seed distances, in cells. */
  f1: number;
  f2: number;
  /** Distance to the edge of the nearest seed's cell (the nearest bisector), in cells. */
  edge: number;
  /** Hash of the neighbour across that edge. */
  edgeHash: number;
  /** Unit vector from the nearest seed toward that neighbour. */
  nx: number;
  ny: number;
  /** Distance to the second-nearest bisector, in cells, and its unit vector (as nx, ny). */
  edge2: number;
  n2x: number;
  n2y: number;
}

export const createVoronoiSample = (): VoronoiSample => ({
  hash: 0,
  f1: 0,
  f2: 0,
  edge: 0,
  edgeHash: 0,
  nx: 0,
  ny: 1,
  edge2: 0,
  n2x: 0,
  n2y: -1,
});

/** Seed offset of the cell with hash `h` (and indices ix, iy), written to `out`. */
export type VoronoiOffset = (h: number, ix: number, iy: number, out: number[]) => number[];

const sx = new Float64Array(49);
const sy = new Float64Array(49);
const sh = new Uint32Array(49);
const off = [0, 0];

/**
 * JS twin of `voronoiCell` at grid point (gx, gy), with seed offsets from `offset`,
 * searching the (2r+1)^2 cells around it (r at most 3). r = 1 is what the shader
 * does; the tests compare it with a wider brute-force search. The edge distance
 * is the smallest distance to a bisector between the nearest seed and any other
 * searched seed, which is the exact distance to the cell's boundary (the cell is
 * the intersection of those half-planes). The second-nearest bisector comes too.
 */
export function voronoiSample(
  gx: number,
  gy: number,
  offset: VoronoiOffset,
  out: VoronoiSample,
  r = 1,
): VoronoiSample {
  const cx = Math.floor(gx);
  const cy = Math.floor(gy);
  let n = 0;
  let best = 0;
  let f1 = Infinity;
  let f2 = Infinity;
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const h = voronoiHash(cx + i, cy + j);
      offset(h, cx + i, cy + j, off);
      sx[n] = cx + i + 0.5 + off[0];
      sy[n] = cy + j + 0.5 + off[1];
      sh[n] = h;
      const dd = (gx - sx[n]) ** 2 + (gy - sy[n]) ** 2;
      if (dd < f1) {
        f2 = f1;
        f1 = dd;
        best = n;
      } else if (dd < f2) {
        f2 = dd;
      }
      n++;
    }
  }
  let edge = Infinity;
  let edgeHash = 0;
  let nx = 0;
  let ny = 1;
  let edge2 = Infinity;
  let n2x = 0;
  let n2y = -1;
  for (let k = 0; k < n; k++) {
    if (k === best) {
      continue;
    }
    const dd = (gx - sx[k]) ** 2 + (gy - sy[k]) ** 2;
    const len = Math.hypot(sx[k] - sx[best], sy[k] - sy[best]);
    const e = (dd - f1) / (2 * len);
    if (e < edge) {
      edge2 = edge;
      n2x = nx;
      n2y = ny;
      edge = e;
      edgeHash = sh[k];
      nx = (sx[k] - sx[best]) / len;
      ny = (sy[k] - sy[best]) / len;
    } else if (e < edge2) {
      edge2 = e;
      n2x = (sx[k] - sx[best]) / len;
      n2y = (sy[k] - sy[best]) / len;
    }
  }
  out.hash = sh[best];
  out.f1 = Math.sqrt(f1);
  out.f2 = Math.sqrt(f2);
  out.edge = edge;
  out.edgeHash = edgeHash;
  out.nx = nx;
  out.ny = ny;
  out.edge2 = edge2;
  out.n2x = n2x;
  out.n2y = n2y;
  return out;
}
