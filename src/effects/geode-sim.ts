/**
 * Pure logic for the geode, shared by `geode.ts` and its tests: the mineral
 * palettes, where the geode sits in the frame, its noisy oval outline, the crystal
 * points (jittered Voronoi cells over the hollow, each a faceted pyramid) and the
 * circling light with its specular glints.
 *
 * Frame space: x and y in frame heights from the bottom-left corner, y up (as
 * `gl_FragCoord`). Local space `q`: geode units (the geode's radius `r` across its
 * short axis is 1) from the geode centre, rotated by the geode's tilt. The outline
 * is near the ellipse `(q.x / ELONG)^2 + q.y^2 = 1`; `p = (q.x / ELONG, q.y)` is
 * the stretched position whose angle and length place a point against it. Crystal
 * grid space: `q / CELL + origin`, one Voronoi cell per unit. Height `z` points at
 * the viewer, who looks straight down -z (orthographic).
 *
 * Crystals: each cell is a pyramid whose faces all rise at slope `k` from the
 * cell's edges (height `k * edge`), so the face under a point is the face over
 * the nearest edge and its normal leans toward that edge. The whole pyramid also
 * leans, inward on the walls of the hollow, by adding the lean vector `a` to every
 * face's slope: the face normal is `normalize(k n + a, 1)`, with `n` the unit
 * vector toward the nearest edge. Keeping `|a| < k` keeps every face outward.
 */
import { createRng } from "./noise";
import {
  createVoronoiSample,
  SEARCH_BOUND,
  voronoiHash,
  type VoronoiSample,
  voronoiSample,
} from "./voronoi";

export interface Mineral {
  /** Crystal colour at the base, deep in the lining, and at the pale tips. */
  base: string;
  tip: string;
  /** Agate bands: the three colours the stripes cycle through, inner to outer. */
  bands: readonly [string, string, string];
  /** Outer rock crust. */
  crust: string;
}

export const MINERALS = {
  amethyst: {
    base: "#2a0a48",
    tip: "#e6d4f7",
    bands: ["#eeeaf2", "#7d8aa6", "#b49ccc"],
    crust: "#5b5853",
  },
  citrine: {
    base: "#4a1e04",
    tip: "#fff0c2",
    bands: ["#f4eee2", "#a59a86", "#d8b98a"],
    crust: "#5e554a",
  },
  quartz: {
    base: "#30343c",
    tip: "#f4f6fa",
    bands: ["#f0f0f0", "#8692a2", "#bdb6c6"],
    crust: "#585856",
  },
  celestine: {
    base: "#14305a",
    tip: "#e0efff",
    bands: ["#eef3f8", "#7590b0", "#a7a8d2"],
    crust: "#55585c",
  },
} as const satisfies Record<string, Mineral>;

export type MineralName = keyof typeof MINERALS;

/** The mineral for a param value, falling back to amethyst. */
export function mineral(name: string): Mineral {
  return Object.hasOwn(MINERALS, name) ? MINERALS[name as MineralName] : MINERALS.amethyst;
}

/** Long axis over short axis of the cut face. */
export const ELONG = 1.18;
/** Largest summed amplitude of the outline harmonics (outline radius is 1 +- this). */
export const OUTLINE_AMP = 0.07;
/** Harmonics of the outline (k = 2..5): amplitude bound of harmonic k is OUTLINE_AMP / (k - 1). */
export const OUTLINE_MAX = OUTLINE_AMP * (1 + 1 / 2 + 1 / 3 + 1 / 4);
/** Peak-to-peak roughness of the crust's outer edge, in geode units. */
export const ROUGH = 0.035;
/** Depth of the rock crust, and of the crust plus agate rim, from the outline. */
export const CRUST_W = 0.06;
export const RIM_W = 0.2;
/** Drop shadow reach beyond the outline, in geode units. */
export const SHADOW_REACH = 0.12;

/** Crystal cell size, in geode units: about 280 crystals line the default hollow. */
export const CELL = 0.09;
/** Largest jitter of a crystal's seed from its cell centre, in cells (Euclidean). */
export const JITTER = 0.38;
/** True when every seed offset stays inside the exact 3x3 search. */
export const SEARCH_OK = JITTER <= SEARCH_BOUND;
/** Added to grid coordinates so every cell the shader touches has non-negative indices. */
export const GRID_ORIGIN = 1024;
/** Face slope range (height per unit run, in cells) across the crystals. */
export const SLOPE = [0.4, 0.8] as const;
/** Inward lean on the hollow's walls, and each crystal's own random lean. */
export const LEAN = 0.2;
export const LEAN_JITTER = 0.1;

export type SideName = "left" | "right" | "corner";

export interface Outline {
  /** Amplitudes and phases of harmonics k = 2..5. */
  amp: [number, number, number, number];
  phase: [number, number, number, number];
  /** Extra tilt of the oval, radians, and the crystal grid's shift (cells). */
  tilt: number;
  shiftX: number;
  shiftY: number;
}

/** The outline and crystal layout for variation `seed`. Deterministic per seed. */
export function outline(seed: number): Outline {
  const s = Number.isFinite(seed) ? Math.floor(seed) : 0;
  const rng = createRng(115_000 + s);
  const o: Outline = {
    amp: [0, 0, 0, 0],
    phase: [0, 0, 0, 0],
    tilt: (rng() - 0.5) * 0.3,
    shiftX: 0,
    shiftY: 0,
  };
  for (let i = 0; i < 4; i++) {
    o.amp[i] = (OUTLINE_AMP / (i + 1)) * (0.45 + 0.55 * rng());
    o.phase[i] = rng() * 2 * Math.PI;
  }
  o.shiftX = Math.floor(rng() * 512);
  o.shiftY = Math.floor(rng() * 512);
  return o;
}

/** Outline radius (in stretched units, near 1) at angle `theta` of p, without roughness. */
export function outlineRadius(theta: number, o: Outline): number {
  let r = 1;
  for (let i = 0; i < 4; i++) r += o.amp[i] * Math.cos((i + 2) * theta + o.phase[i]);
  return r;
}

/** Depth of local point (qx, qy) inside the outline, in geode units (negative outside). */
export function depth(qx: number, qy: number, o: Outline): number {
  const px = qx / ELONG;
  return outlineRadius(Math.atan2(qy, px), o) - Math.hypot(px, qy);
}

export interface Layout {
  /** Geode centre, frame heights from the bottom-left. */
  cx: number;
  cy: number;
  /** Geode radius across its short axis, frame heights. */
  r: number;
  /** Rotation of local space, radians (counter-clockwise). */
  angle: number;
  /** Half side of the square quad that covers the geode and its shadow, frame heights. */
  half: number;
}

const SIDES = {
  left: { x: 0.8, y: 0.5, angle: 0.18, fromRight: false, corner: false },
  right: { x: 0.8, y: 0.5, angle: -0.18, fromRight: true, corner: false },
  corner: { x: 0.62, y: 0.62, angle: 0.5, fromRight: true, corner: true },
} as const;

/**
 * Where the geode sits for side `side`, size `size` (its short axis as a fraction
 * of the frame height) and aspect `aspect` (width / height), written to `out`.
 * It hugs one side, or the bottom-right corner, and runs a little off the frame.
 */
export function layout(side: string, size: number, aspect: number, tilt: number, out: Layout) {
  const s = Object.hasOwn(SIDES, side) ? SIDES[side as SideName] : SIDES.left;
  const r = 0.5 * (Number.isFinite(size) ? Math.min(Math.max(size, 0.2), 2) : 0.85);
  const across = r * ELONG * s.x;
  out.r = r;
  out.cx = s.fromRight ? aspect - across : across;
  out.cy = s.corner ? r * s.y : s.y;
  out.angle = s.angle + tilt;
  out.half = r * (ELONG * (1 + OUTLINE_MAX + ROUGH) + SHADOW_REACH);
  return out;
}

/** Byte `i` (0..3) of `h` mapped to [-1, 1], as the shader does. */
const byteUnit = (h: number, i: number) => ((h >>> (i * 8)) & 255) * (2 / 255) - 1;

/**
 * Offset of the crystal seed with hash `h` from its cell centre, written to `out`:
 * two hash bytes mapped from the square onto a disc of radius JITTER. The JS twin
 * of the shader's `voronoiOffset`.
 */
export function crystalOffset(h: number, out: number[]): number[] {
  const bx = byteUnit(h, 0);
  const by = byteUnit(h, 1);
  out[0] = JITTER * bx * Math.sqrt(1 - 0.5 * by * by);
  out[1] = JITTER * by * Math.sqrt(1 - 0.5 * bx * bx);
  return out;
}

const offsetFn = (h: number, _ix: number, _iy: number, out: number[]) => crystalOffset(h, out);

/** Face slope of the crystal with hash `h` (byte 2). */
export function crystalSlope(h: number): number {
  return SLOPE[0] + (SLOPE[1] - SLOPE[0]) * ((h >>> 16) & 255) * (1 / 255);
}

/**
 * Lean of the crystal with hash `h` whose seed is at local point (qx, qy), written
 * to `out`: inward toward the geode's centre, more so toward the walls, plus its
 * own small lean (direction from byte 3). Its length stays below LEAN + LEAN_JITTER.
 */
export function crystalLean(h: number, qx: number, qy: number, out: number[]): number[] {
  const len = Math.hypot(qx, qy);
  const rho = Math.min(Math.hypot(qx / ELONG, qy) / (1 - RIM_W), 1);
  const w = len > 1e-9 ? (LEAN * smoothstep01((rho - 0.15) / 0.85)) / len : 0;
  const phi = ((h >>> 24) & 255) * ((2 * Math.PI) / 256);
  out[0] = -w * qx + LEAN_JITTER * Math.cos(phi);
  out[1] = -w * qy + LEAN_JITTER * Math.sin(phi);
  return out;
}

function smoothstep01(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
}

/** Unit normal of a face with edge direction (nx, ny), slope k and lean (ax, ay), written to `out`. */
export function facetNormal(
  nx: number,
  ny: number,
  k: number,
  ax: number,
  ay: number,
  out: number[],
): number[] {
  const x = k * nx + ax;
  const y = k * ny + ay;
  const inv = 1 / Math.sqrt(x * x + y * y + 1);
  out[0] = x * inv;
  out[1] = y * inv;
  out[2] = inv;
  return out;
}

export interface Crystal {
  /** Hash of the crystal's cell, and its seed in local space. */
  hash: number;
  seedX: number;
  seedY: number;
  /** Distance to the crystal's nearest base edge, in cells (its height is slope * edge). */
  edge: number;
  /** Unit vector toward that edge. */
  edgeX: number;
  edgeY: number;
  /** Unit normal of the face under the point. */
  normal: number[];
}

export const createCrystal = (): Crystal => ({
  hash: 0,
  seedX: 0,
  seedY: 0,
  edge: 0,
  edgeX: 0,
  edgeY: 1,
  normal: [0, 0, 1],
});

const sample: VoronoiSample = createVoronoiSample();
const lean = [0, 0];
const off = [0, 0];

/**
 * The crystal and face under local point (qx, qy) for outline `o`, written to
 * `out`: the twin of the shader's crystal lookup (3x3 search, or r for tests).
 */
export function crystalAt(qx: number, qy: number, o: Outline, out: Crystal, r = 1): Crystal {
  const ox = GRID_ORIGIN + o.shiftX;
  const oy = GRID_ORIGIN + o.shiftY;
  const v = voronoiSample(qx / CELL + ox, qy / CELL + oy, offsetFn, sample, r);
  // The sample gives the seed's hash, not its position: find its cell around g.
  const gx = Math.floor(qx / CELL + ox);
  const gy = Math.floor(qy / CELL + oy);
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      if (voronoiHash(gx + i, gy + j) !== v.hash) continue;
      crystalOffset(v.hash, off);
      out.seedX = (gx + i + 0.5 + off[0] - ox) * CELL;
      out.seedY = (gy + j + 0.5 + off[1] - oy) * CELL;
    }
  }
  out.hash = v.hash;
  out.edge = v.edge;
  out.edgeX = v.nx;
  out.edgeY = v.ny;
  crystalLean(v.hash, out.seedX, out.seedY, lean);
  facetNormal(v.nx, v.ny, crystalSlope(v.hash), lean[0], lean[1], out.normal);
  return out;
}

/** Seconds per circuit of the light at speed 1, and per cycle of its slow rise and fall. */
export const LIGHT_PERIOD = 48;
export const RISE_PERIOD = 131;
/** Light circle radius and mean height above the cut face, in geode units, and the rise depth. */
export const LIGHT_R = 0.8;
export const LIGHT_H = 1;
export const LIGHT_RISE = 0.15;

/** Advances a phase (cycles, wrapped to [0, 1)) by `dt` seconds at `rate` cycles per second. */
export function advancePhase(phase: number, dt: number, rate: number): number {
  const r = Number.isFinite(rate) ? Math.max(rate, 0) : 0;
  const p = phase + dt * r;
  return p - Math.floor(p);
}

/** Light position in local space at circuit phase `phase` and rise phase `rise` (cycles), into `out`. */
export function lightPosition(phase: number, rise: number, out: number[]): number[] {
  const a = 2 * Math.PI * phase;
  out[0] = LIGHT_R * Math.cos(a);
  out[1] = LIGHT_R * Math.sin(a);
  out[2] = LIGHT_H * (1 + LIGHT_RISE * Math.sin(2 * Math.PI * rise));
  return out;
}

/** Specular exponents: the narrow glint lobe and the broad sheen. */
export const GLINT_EXP = 400;
export const SHEEN_EXP = 24;

/**
 * Blinn-Phong lobe `max(N.H, 0)^exponent` at local point (px, py, 0) with unit
 * normal `n`, for a point light at `light` and a viewer straight above. Smooth in
 * the light position, so a face's glint fades in and out as the light moves.
 */
export function specular(
  n: readonly number[],
  px: number,
  py: number,
  light: readonly number[],
  exponent: number,
): number {
  const lx = light[0] - px;
  const ly = light[1] - py;
  const lz = light[2];
  const il = 1 / Math.sqrt(lx * lx + ly * ly + lz * lz);
  const hx = lx * il;
  const hy = ly * il;
  const hz = lz * il + 1;
  const ih = 1 / Math.sqrt(hx * hx + hy * hy + hz * hz);
  const d = (n[0] * hx + n[1] * hy + n[2] * hz) * ih;
  return d > 0 ? d ** exponent : 0;
}
