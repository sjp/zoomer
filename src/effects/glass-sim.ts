/**
 * Pure logic for the stained-glass effect, shared by `glass.ts` and its tests:
 * the jittered, drifting Voronoi seeds (a JS twin of the shader's), the palettes,
 * the sun patch path and the ambient level.
 *
 * Grid space: one unit per pane cell, y down. Cell (ix, iy) owns one seed at
 * `(ix + 0.5, iy + 0.5) + jitter + drift`, where the jitter is a fixed point in a
 * disc of radius `JITTER` and the drift a closed path of radius at most `DRIFT_MAX`.
 */
import { hash32 } from "./noise";

/** Largest base jitter of a seed from its cell centre, in cells (Euclidean). */
export const JITTER = 0.3;
/** Largest drift of a seed from its jittered position at `drift` = 1, in cells. */
export const DRIFT_MAX = 0.08;
/**
 * Largest offset of a seed from its cell centre for which a 3x3 search still finds
 * the nearest and second-nearest seeds exactly. For a point in cell (0, 0), every
 * seed outside the 3x3 block is at least `1.5 - R` away along one axis, while the
 * second-nearest of the 3x3 cell centres is at most `sqrt(1/2)` away (the worst
 * case being a cell corner, where four centres are that close), so F2 is at most
 * `sqrt(1/2) + R`. The search is exact when `sqrt(1/2) + R <= 1.5 - R`. The test
 * checks the bound numerically against a brute-force search.
 */
export const SEARCH_BOUND = (1.5 - Math.SQRT1_2) / 2;
/** Seconds per loop of a seed's drift path. */
export const DRIFT_PERIOD = 45;
/**
 * Added to grid coordinates so every cell the shader touches has non-negative
 * indices that fit in 12 bits (the hash key packs x and y into 12 bits each).
 */
export const GRID_ORIGIN = 512;

/** Seed hash of cell (ix, iy): the same bits as the shader's `hash32(key)`. */
export function seedHash(ix: number, iy: number): number {
  return hash32((ix & 0xfff) | ((iy & 0xfff) << 12));
}

/** Second hash of a seed, for its colour, glass kind and texture offset. */
export function paneHash(h: number): number {
  return hash32(h ^ 0x5bd1e995);
}

/** Byte `i` (0..3) of `h` mapped to [-1, 1], as the shader does. */
const byteUnit = (h: number, i: number) => ((h >>> (i * 8)) & 255) * (2 / 255) - 1;

/**
 * Drift uniform for time `t` (seconds, any size) and `drift` (0..1): the shared
 * point on every seed's closed path, pre-scaled by `DRIFT_MAX * drift / sqrt(2)`
 * (the length of a seed's drift vector is at most sqrt(2)).
 */
export function driftUniform(t: number, drift: number, out: number[]): number[] {
  const a = ((t / DRIFT_PERIOD) % 1) * 2 * Math.PI;
  const amp = (DRIFT_MAX * Math.min(Math.max(drift, 0), 1)) / Math.SQRT2;
  out[0] = amp * Math.cos(a);
  out[1] = amp * Math.sin(a);
  return out;
}

/**
 * Offset of cell (ix, iy)'s seed from the cell centre for drift uniform `d` (from
 * `driftUniform`), written to `out`. Mirrors the shader exactly: base jitter maps
 * two hash bytes from the square onto the unit disc, and the drift rotates the
 * shared path point by the seed's own (unnormalised) hash vector, in the seed's
 * own direction.
 */
export function seedOffset(ix: number, iy: number, d: readonly number[], out: number[]): number[] {
  const h = seedHash(ix, iy);
  const bx = byteUnit(h, 0);
  const by = byteUnit(h, 1);
  const vx = byteUnit(h, 2);
  const vy = byteUnit(h, 3);
  const sign = h & 1 ? 1 : -1;
  const c = d[0];
  const s = d[1] * sign;
  out[0] = JITTER * bx * Math.sqrt(1 - 0.5 * by * by) + vx * c - vy * s;
  out[1] = JITTER * by * Math.sqrt(1 - 0.5 * bx * bx) + vy * c + vx * s;
  return out;
}

export interface VoronoiSample {
  /** Hash of the nearest seed (`seedHash`). */
  hash: number;
  /** Nearest and second-nearest seed distances, in cells. */
  f1: number;
  f2: number;
  /** Distance to the edge of the nearest seed's cell (the nearest bisector), in cells. */
  edge: number;
}

export const createVoronoiSample = (): VoronoiSample => ({ hash: 0, f1: 0, f2: 0, edge: 0 });

const sx = new Float64Array(49);
const sy = new Float64Array(49);
const sh = new Uint32Array(49);
const off = [0, 0];

/**
 * Voronoi sample at grid point (gx, gy) for drift uniform `d`, searching the
 * (2r+1)^2 cells around it. r = 1 is what the shader does; the tests compare it
 * with a wider brute-force search. The edge distance is the smallest distance to
 * a bisector between the nearest seed and any other searched seed, which is the
 * exact distance to the cell's boundary (the cell is the intersection of those
 * half-planes).
 */
export function voronoi(
  gx: number,
  gy: number,
  d: readonly number[],
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
      seedOffset(cx + i, cy + j, d, off);
      sx[n] = cx + i + 0.5 + off[0];
      sy[n] = cy + j + 0.5 + off[1];
      sh[n] = seedHash(cx + i, cy + j);
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
  for (let k = 0; k < n; k++) {
    if (k === best) continue;
    const dd = (gx - sx[k]) ** 2 + (gy - sy[k]) ** 2;
    const e = (dd - f1) / (2 * Math.hypot(sx[k] - sx[best], sy[k] - sy[best]));
    if (e < edge) edge = e;
  }
  out.hash = sh[best];
  out.f1 = Math.sqrt(f1);
  out.f2 = Math.sqrt(f2);
  out.edge = edge;
  return out;
}

/** Colours per palette; the shader picks one by the low three bits of `paneHash`. */
export const PALETTE_SIZE = 8;

export const PALETTES = {
  cathedral: [
    "#a3161c",
    "#c42a2a",
    "#1d3c9c",
    "#142b6e",
    "#1e7a43",
    "#d8a21e",
    "#b8741a",
    "#5b2a80",
  ],
  tiffany: ["#d9902a", "#c06a1e", "#e8c27a", "#f0e2b6", "#7a9a3a", "#4f7a34", "#a8b85a", "#e0a85a"],
  // Two near-clear panes in eight.
  modern: ["#f2b3c0", "#b5d4ee", "#c4e3bc", "#f4e0a2", "#d4c4ec", "#eef2f3", "#e3eaee", "#efcdae"],
} as const satisfies Record<string, readonly string[]>;

export type PaletteName = keyof typeof PALETTES;

/** The palette for a param value, falling back to cathedral. */
export function palette(name: string): readonly string[] {
  return Object.hasOwn(PALETTES, name) ? PALETTES[name as PaletteName] : PALETTES.cathedral;
}

/** Palette index of the pane with seed hash `h`, as the shader picks it. */
export function paneColorIndex(h: number): number {
  return paneHash(h) & (PALETTE_SIZE - 1);
}

/** Seconds per loop of the sun patch. */
export const SUN_PERIOD = 150;
/** Sun path: horizontal and vertical swing about the frame centre, in frame heights / widths. */
const SUN_SWING_X = 0.4;
const SUN_SWING_Y = 0.2;

/**
 * Centre of the sun patch at time `t` (seconds, any size): x as a fraction of the
 * frame width, y of the height (y down). A closed figure-of-eight that crosses
 * the frame once each way per `SUN_PERIOD`.
 */
export function sunAt(t: number, out: number[]): number[] {
  const a = ((t / SUN_PERIOD) % 1) * 2 * Math.PI;
  out[0] = 0.5 + SUN_SWING_X * Math.sin(a + 0.4);
  out[1] = 0.45 + SUN_SWING_Y * Math.sin(2 * a + 1.1);
  return out;
}

/** Ambient light through the window: a base level with a slow, small wander. */
export const AMBIENT = 0.68;
export function ambientAt(t: number): number {
  const w = 2 * Math.PI * t;
  return AMBIENT + 0.035 * Math.sin(w / 37) + 0.025 * Math.sin(w / 23 + 1);
}
