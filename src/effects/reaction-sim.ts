/**
 * Pure JS side of the reaction–diffusion effect (reaction.ts): the Gray–Scott
 * presets and their drift path, the step-count clock, the seed spots, the RGBA8
 * fallback's 16-bit packing, and a CPU reference of one simulation step that
 * documents the shader's maths.
 *
 * The state is stored as (u, b) with u = 1 - A, so the empty state (A = 1, B = 0)
 * is all zeros: a cleared target is already a blank simulation, and half floats
 * keep their fine precision near zero, where the background sits.
 */
import { createRng } from "./noise";
import { wrap } from "./math";

/** Diffusion rates of A and B, and the time step per simulation step (Karl Sims' units). */
export const DA = 1;
export const DB = 0.5;
export const DT = 1;
/**
 * 3x3 Laplacian weights: centre -1, edge neighbours 0.2, corners 0.05. Isotropic
 * enough that spots stay round, and stable at DT = 1 (its largest eigenvalue
 * magnitude is 1.6, so DA * DT * 1.6 < 2).
 */
export const LAP_EDGE = 0.2;
export const LAP_CORNER = 0.05;

export interface Preset {
  label: string;
  /** Feed rate F and kill rate k at the centre of the drift path. */
  feed: number;
  kill: number;
  /** Half-axes of the drift ellipse in (F, k) at drift 1: small, so the family holds. */
  driftFeed: number;
  driftKill: number;
}

/** Pattern families, as (F, k) pairs for DA = 1, DB = 0.5 and the stencil above. */
export const PRESETS = {
  coral: { label: "Coral", feed: 0.0545, kill: 0.062, driftFeed: 0.003, driftKill: 0.0006 },
  spots: { label: "Spots", feed: 0.035, kill: 0.065, driftFeed: 0.001, driftKill: 0.0006 },
  stripes: { label: "Stripes", feed: 0.037, kill: 0.06, driftFeed: 0.002, driftKill: 0.0008 },
  labyrinth: { label: "Labyrinth", feed: 0.03, kill: 0.057, driftFeed: 0.0012, driftKill: 0.0008 },
  mitosis: { label: "Mitosis", feed: 0.0367, kill: 0.0649, driftFeed: 0.0015, driftKill: 0.0004 },
} as const satisfies Record<string, Preset>;

export type PatternId = keyof typeof PRESETS;

export const PATTERN_OPTIONS = Object.entries(PRESETS).map(([value, p]) => ({
  value,
  label: p.label,
}));

/** The preset for a select value; unknown values fall back to coral. */
export function presetFor(id: string): Preset {
  return Object.hasOwn(PRESETS, id) ? PRESETS[id as PatternId] : PRESETS.coral;
}

/** Seconds per lap of the drift path. */
export const DRIFT_PERIOD = 120;
const TAU = Math.PI * 2;

/** Advances the drift phase (radians, kept in [0, 2pi)) by `dt` seconds. */
export function advanceDrift(phase: number, dt: number): number {
  return wrap(phase + (TAU * dt) / DRIFT_PERIOD, 0, TAU);
}

/**
 * Feed and kill at `phase` along the preset's drift ellipse, scaled by `drift`
 * (0..1), written to `out[0]` and `out[1]`. The path is closed and smooth, so the
 * pattern wanders around its family and comes back rather than running off.
 */
export function driftedFeedKill(p: Preset, drift: number, phase: number, out: Float64Array): void {
  out[0] = p.feed + p.driftFeed * drift * Math.cos(phase);
  out[1] = p.kill + p.driftKill * drift * Math.sin(phase);
}

/** Fractional steps owed, carried between frames. */
export interface StepClock {
  acc: number;
}

/**
 * Steps to run this frame at `rate` steps per second, at most `cap`. The fraction
 * left over carries to the next frame; whole steps beyond the cap are dropped, so
 * a long frame or a hidden tab never triggers a burst of catch-up steps.
 */
export function takeSteps(clock: StepClock, rate: number, dt: number, cap: number): number {
  const owed = clock.acc + Math.max(0, rate * dt);
  if (!Number.isFinite(owed)) {
    clock.acc = 0;
    return 0;
  }
  const whole = Math.floor(owed);
  const n = Math.min(whole, cap);
  clock.acc = owed - whole;
  return n;
}

/** Seed spots per reseed. */
export const SPOT_COUNT = 14;

/**
 * Writes SPOT_COUNT seed spots as (x, y, radius) triples to `out`: x and y in 0..1
 * across the grid, the radius in simulation cells. Spots avoid the middle third,
 * where the speaker sits, so the pattern visibly grows in from the sides.
 */
export function makeSpots(seed: number, out: Float32Array): void {
  const rng = createRng(seed * 7919 + 13);
  for (let i = 0; i < SPOT_COUNT; i++) {
    // Alternate sides; anywhere vertically.
    const side = i % 2 === 0 ? 0 : 2 / 3;
    out[i * 3] = side + 0.04 + rng() * (1 / 3 - 0.08);
    out[i * 3 + 1] = 0.05 + rng() * 0.9;
    out[i * 3 + 2] = 3 + rng() * 3;
  }
}

/** Value written inside a seed spot: A = B = 0.5, the classic seed. */
export const SPOT_U = 0.5;
export const SPOT_B = 0.5;

/**
 * Packs a value in [0, 1] into two bytes, as the RGBA8 fallback stores each
 * channel: `[hi, lo]` in 0..1 (bytes / 255). 16 bits are plenty for Gray–Scott,
 * where 8 would stall the slow feed term entirely.
 */
export function pack16(v: number, out: Float64Array, offset: number): void {
  const q = Math.round(Math.min(1, Math.max(0, v)) * 65535);
  const hi = Math.floor(q / 256);
  out[offset] = hi / 255;
  out[offset + 1] = (q - hi * 256) / 255;
}

/** Inverse of `pack16` (the shader's `unpack16`). */
export function unpack16(hi: number, lo: number): number {
  return (Math.round(hi * 255) * 256 + Math.round(lo * 255)) / 65535;
}

/**
 * One Gray–Scott step on a `w` x `h` grid, the CPU twin of STEP_FRAGMENT. Grids
 * hold (u, b) with u = 1 - A. Edges are clamped (zero-flux), like the shader's
 * clamped `texelFetch`. With a = 1 - u:
 *
 *   da = DA * lap(a) - a b^2 + F (1 - a)  ->  du = DA * lap(u) + a b^2 - F u
 *   db = DB * lap(b) + a b^2 - (F + k) b
 */
export function grayScottStep(
  u: Float32Array,
  b: Float32Array,
  w: number,
  h: number,
  feed: number,
  kill: number,
  outU: Float32Array,
  outB: Float32Array,
): void {
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1) * w;
    const y0 = y * w;
    const yp = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(w - 1, x + 1);
      const i = y0 + x;
      const lapU =
        LAP_EDGE * (u[y0 + xm] + u[y0 + xp] + u[ym + x] + u[yp + x]) +
        LAP_CORNER * (u[ym + xm] + u[ym + xp] + u[yp + xm] + u[yp + xp]) -
        u[i];
      const lapB =
        LAP_EDGE * (b[y0 + xm] + b[y0 + xp] + b[ym + x] + b[yp + x]) +
        LAP_CORNER * (b[ym + xm] + b[ym + xp] + b[yp + xm] + b[yp + xp]) -
        b[i];
      const uu = u[i];
      const bb = b[i];
      const react = (1 - uu) * bb * bb;
      outU[i] = Math.min(1, Math.max(0, uu + DT * (DA * lapU + react - feed * uu)));
      outB[i] = Math.min(1, Math.max(0, bb + DT * (DB * lapB + react - (feed + kill) * bb)));
    }
  }
}
