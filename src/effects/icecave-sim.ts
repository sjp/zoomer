/**
 * Pure logic for the ice cave, shared by `icecave.ts` and its tests: the tunnel
 * projection, the scallop seed offsets (the JS twin of the shader's
 * `voronoiOffset`), the ice translucency model, the colour presets, and the
 * icicles with their seeded drip schedule.
 *
 * Screen space: frame heights, x from the frame centre, y from the top (y down).
 * Tunnel space: an elliptic cylinder of vertical radius 1 (`ELLIPSE` times wider)
 * along the view axis, seen from its axis. A wall point is (a, z): `a` the angle
 * around the axis in turns (0 at the ceiling, +-0.5 on the floor centre line, so
 * the wrap seam lies under the floor shading) and `z` the distance along the axis.
 */
import { SEARCH_BOUND } from "./voronoi";

/** Width of the tunnel's cross-section relative to its height. */
export const ELLIPSE = 1.3;
/** Focal length, in frame heights. */
export const FOCAL = 1;
/** Depth of the far opening (the mouth), in tunnel radii. */
export const Z_END = 8;
/** Depths beyond this are clamped, so the axis itself stays finite. */
export const Z_MAX = 64;

export interface Mouth {
  /** Vanishing point: x in frame heights from the centre, y from the top. */
  x: number;
  y: number;
}

export const MOUTHS = {
  left: { x: -0.5, y: 0.47 },
  right: { x: 0.5, y: 0.47 },
  far: { x: 0, y: 0.46 },
} as const satisfies Record<string, Mouth>;

export type MouthName = keyof typeof MOUTHS;

/** The mouth for a param value, falling back to right. */
export function mouth(name: string): Mouth {
  return Object.hasOwn(MOUTHS, name) ? MOUTHS[name as MouthName] : MOUTHS.right;
}

/** Elliptic radius of a screen point about the vanishing point, in frame heights. */
export function tunnelRadius(x: number, y: number, m: Mouth): number {
  return Math.hypot((x - m.x) / ELLIPSE, y - m.y);
}

/**
 * Wall point under screen point (x, y), written to `out` as [a, z]. The wall at
 * depth z projects to the ellipse of radius FOCAL / z, so z = FOCAL / radius,
 * clamped to Z_MAX on the axis. Matches the shader's mapping.
 */
export function wallFromScreen(x: number, y: number, m: Mouth, out: number[]): number[] {
  const qx = (x - m.x) / ELLIPSE;
  const qy = m.y - y;
  const r = Math.hypot(qx, qy);
  out[0] = Math.atan2(-qx, qy) / (2 * Math.PI);
  out[1] = r > FOCAL / Z_MAX ? FOCAL / r : Z_MAX;
  return out;
}

/** Screen point of wall point (a, z), written to `out` as [x, y]. */
export function screenFromWall(a: number, z: number, m: Mouth, out: number[]): number[] {
  const r = FOCAL / z;
  const t = a * 2 * Math.PI;
  out[0] = m.x - Math.sin(t) * r * ELLIPSE;
  out[1] = m.y - Math.cos(t) * r;
  return out;
}

/** Scallops around the tunnel, and per unit of depth (about square cells). */
export const CELLS_AROUND = 30;
export const CELLS_ALONG = 4;
/** Added to scallop grid coordinates so every cell index is non-negative. */
export const GRID_ORIGIN = 1024;
/** Largest offset of a scallop's seed from its cell centre, in cells (Euclidean). */
export const JITTER = 0.36;
/** True when every seed offset stays inside the exact 3x3 search. */
export const SEARCH_OK = JITTER <= SEARCH_BOUND;

/** Byte `i` (0..3) of `h` mapped to [-1, 1], as the shader does. */
const byteUnit = (h: number, i: number) => ((h >>> (i * 8)) & 255) * (2 / 255) - 1;

/**
 * Seed offset of the scallop with hash `h`, written to `out`. Mirrors the shader's
 * `voronoiOffset`: two hash bytes map from the square onto a disc of radius JITTER.
 */
export function seedOffset(h: number, out: number[]): number[] {
  const bx = byteUnit(h, 0);
  const by = byteUnit(h, 1);
  out[0] = JITTER * bx * Math.sqrt(1 - 0.5 * by * by);
  out[1] = JITTER * by * Math.sqrt(1 - 0.5 * bx * bx);
  return out;
}

/** Ice thickness: base, swing over the slow noise (0..1), dark band depth, and dish thinning. */
export const THICK_BASE = 0.35;
export const THICK_NOISE = 2.2;
export const THICK_BAND = 1.1;
export const THICK_DISH = 0.45;

/**
 * Optical thickness of the ice for slow noise `n` (0..1), dark band strength
 * `band` (0..1) and dish depth `dish` (0 on a scallop's rim, 1 at its centre,
 * where the hollow thins the ice). Never negative.
 */
export function thickness(n: number, band: number, dish: number): number {
  return Math.max(THICK_BASE + THICK_NOISE * n + THICK_BAND * band - THICK_DISH * dish, 0);
}

/** Light let through the ice, exp(-thickness): 1 where thin, toward 0 where thick. */
export function transmission(t: number): number {
  return Math.exp(-Math.max(t, 0));
}

export interface IcePalette {
  /** Ramp from thick to thin ice. */
  deep: string;
  mid: string;
  thin: string;
  /** Daylight at the mouth. */
  day: string;
}

export const PALETTES = {
  glacier: { deep: "#020d26", mid: "#1b5fae", thin: "#a6e4ff", day: "#eef8ff" },
  turquoise: { deep: "#011c24", mid: "#0f8f9c", thin: "#b2fff0", day: "#f0fffb" },
  deep: { deep: "#01040f", mid: "#0b2770", thin: "#5d9cff", day: "#c4dcff" },
} as const satisfies Record<string, IcePalette>;

export type PaletteName = keyof typeof PALETTES;

/** The palette for a param value, falling back to glacier. */
export function palette(name: string): IcePalette {
  return Object.hasOwn(PALETTES, name) ? PALETTES[name as PaletteName] : PALETTES.glacier;
}

/** Icicles: count, and the part of the width (from each side) they hang in, away from the speaker. */
export const ICICLES = 12;
export const ICICLE_BAND = 0.34;
/** Icicle tip depth below the top edge and half width at the base, in reference px (1080p). */
export const ICICLE_LEN: readonly [number, number] = [45, 190];
export const ICICLE_WIDTH: readonly [number, number] = [3.5, 7];

export interface Icicle {
  /** Tip x as a fraction of the frame width. */
  x: number;
  /** Tip y below the top edge, reference px. */
  tip: number;
  /** Half width at the base, reference px. */
  width: number;
  /** Brightness, 0..1. */
  glow: number;
}

/**
 * `count` icicles, half on each side, stratified across the outer `ICICLE_BAND`
 * of the width so they never bunch up or hang in front of the speaker.
 */
export function createIcicles(rng: () => number, count = ICICLES): Icicle[] {
  const out: Icicle[] = [];
  const half = Math.ceil(count / 2);
  for (let k = 0; k < count; k++) {
    const side = k < half ? 0 : 1;
    const n = side === 0 ? half : count - half;
    const j = side === 0 ? k : k - half;
    const f = ((j + 0.15 + 0.7 * rng()) / n) * ICICLE_BAND;
    const t = rng();
    out.push({
      x: side === 0 ? f : 1 - f,
      tip: ICICLE_LEN[0] + (ICICLE_LEN[1] - ICICLE_LEN[0]) * t * t,
      width: ICICLE_WIDTH[0] + (ICICLE_WIDTH[1] - ICICLE_WIDTH[0]) * rng(),
      glow: 0.55 + 0.45 * rng(),
    });
  }
  return out;
}

/** Seconds a drop swells at the tip before it falls. */
export const DROP_HANG = 1.4;
/** Fall acceleration in reference px/s^2 (about g, at 300 px to the metre). */
export const DROP_G = 2600;
/** Mean seconds between drops of one icicle at drip rate 1. */
export const DRIP_MEAN = 9;
/** Drop radius when it falls, reference px. */
export const DROP_R = 2.2;

/** Per-icicle drip state: countdown to the next drop (in rate-scaled seconds) and the drop's age (< 0: none). */
export interface DripState {
  readonly next: Float64Array;
  readonly age: Float64Array;
}

/** Seconds (at rate 1) until an icicle's next drop: spread 0.3 to 1.7 times the mean. */
const interval = (rng: () => number) => DRIP_MEAN * (0.3 + 1.4 * rng());

/** Drip state for `count` icicles, with the first drops spread over one mean interval. */
export function createDrips(count: number, rng: () => number): DripState {
  const s = { next: new Float64Array(count), age: new Float64Array(count) };
  for (let i = 0; i < count; i++) {
    s.next[i] = DRIP_MEAN * rng();
    s.age[i] = -1;
  }
  return s;
}

/**
 * Advances the drips by `dt` seconds at drip rate `rate` (0 stops new drops; ones
 * already forming still fall). An icicle's countdown runs at `rate`; when it ends
 * and the icicle has no drop, a drop starts swelling at its tip. A drop ends once
 * it has fallen `fall` reference px (past the bottom of the frame).
 */
export function stepDrips(
  s: DripState,
  dt: number,
  rate: number,
  fall: number,
  rng: () => number,
): void {
  const r = Number.isFinite(rate) ? Math.max(rate, 0) : 0;
  const life = DROP_HANG + Math.sqrt((2 * Math.max(fall, 0)) / DROP_G);
  for (let i = 0; i < s.age.length; i++) {
    if (s.age[i] >= 0) {
      s.age[i] += dt;
      if (s.age[i] > life) s.age[i] = -1;
    }
    if (r > 0) {
      s.next[i] -= dt * r;
      if (s.next[i] <= 0) {
        s.next[i] += interval(rng);
        // Busy icicle: this drop is skipped rather than queued.
        if (s.age[i] < 0) s.age[i] = 0;
      }
    }
  }
}

/** Fall distance below the tip (reference px) of a drop of age `age` seconds. */
export function dropFall(age: number): number {
  const t = Math.max(age - DROP_HANG, 0);
  return 0.5 * DROP_G * t * t;
}

/** Fall speed (reference px/s) of a drop of age `age` seconds. */
export function dropSpeed(age: number): number {
  return DROP_G * Math.max(age - DROP_HANG, 0);
}

/** Swell of a hanging drop, 0..1 (1 at the moment it lets go). */
export function dropSwell(age: number): number {
  const t = Math.min(Math.max(age / DROP_HANG, 0), 1);
  return t * t * (3 - 2 * t);
}
