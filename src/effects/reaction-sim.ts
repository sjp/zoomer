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
 * clamped `texelFetch`. `front` is the retreat front (see `cycleFront`); cells
 * behind it get extra kill (`retreatKill`). With a = 1 - u:
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
  front = -1,
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
      const k = kill + retreatKill((x + 0.5) / w, front);
      outU[i] = Math.min(1, Math.max(0, uu + DT * (DA * lapU + react - feed * uu)));
      outB[i] = Math.min(1, Math.max(0, bb + DT * (DB * lapB + react - (feed + k) * bb)));
    }
  }
}

/**
 * The grow / retreat life cycle. A pattern grows in from the seed spots until it
 * stops spreading, holds for a while, then retreats: a "front" sweeps out from
 * the centre line to the side edges, raising the kill rate behind it (by
 * RETREAT_KILL) so the pattern dies back toward the sides it grew in from. Once
 * nothing is left the grid is reseeded with new spots and it all starts again.
 *
 * Progress is counted in simulation steps, so the pace follows the speed param,
 * and coverage comes from occasional GPU readbacks (see `readStats`).
 */
export type CyclePhase = "grow" | "hold" | "retreat" | "clear";

/** Extra kill rate behind the retreat front: enough to end every preset's pattern. */
export const RETREAT_KILL = 0.02;
/** Width of the front's ramp from no extra kill to RETREAT_KILL, in half-widths of the grid. */
export const FRONT_BAND = 0.15;
/** Front speed: simulation steps per grid cell of the half-width it sweeps. */
export const RETREAT_STEPS_PER_CELL = 20;
/** B above this counts a cell as part of the pattern (the colour ramp starts at 0.06). */
export const COVER_B = 0.1;
/** The grid counts as empty when no cell's B is above this. */
export const EMPTY_B = 0.03;
/** Simulation steps between coverage readbacks. */
export const SAMPLE_STEPS = 250;
/**
 * Growth has stopped when, over the last SETTLE_SAMPLES samples, no stats tile's
 * coverage moved by more than SETTLE_TILE_DELTA. Per tile, so a few growing
 * clusters on a big grid still count as growing, while the slow, even shimmer of
 * the drift doesn't.
 */
export const SETTLE_SAMPLES = 4;
export const SETTLE_TILE_DELTA = 0.07;
/** Consecutive still checks needed, so one quiet moment mid-growth doesn't count. */
export const SETTLE_CHECKS = 2;
/**
 * Smallest stats tile side, in cells. Settled patterns keep reorganising a
 * little, which on small tiles looks just like growth; tiles several features
 * wide average that out (measured with the CPU twin: growing tiles change by
 * 0.09 to 0.7 per 1000 steps, settled ones by 0.06 at most).
 */
export const STATS_TILE_CELLS = 40;
/** Less coverage than this is not a finished pattern, however still. */
export const MIN_COVERAGE = 0.03;
/**
 * Tiles allowed to still be changing in a settled pattern, as a fraction of the
 * tiles (at least one): a lone noisy tile, or the last corner filling in, doesn't
 * hold the whole cycle up. Early growth moves many more (one per seed cluster).
 */
export const SETTLE_MOVING_FRACTION = 0.02;
/**
 * Fallbacks for when readback is unavailable or a pattern never settles: the
 * longest growth (seconds of running simulation, so the wait doesn't depend on
 * the grid size or speed) and the clear-out after the sweep (steps).
 */
export const GROW_FALLBACK_SECONDS = 150;
export const CLEAR_FALLBACK_STEPS = 3000;

/** Side of the square stats target: each texel summarises one tile of the grid. */
export const STATS_SIZE = 32;
const STATS_TILES = STATS_SIZE * STATS_SIZE;

export interface Cycle {
  phase: CyclePhase;
  /** Steps run in this phase. */
  steps: number;
  /** Seconds spent in this phase while the simulation was running. */
  seconds: number;
  /** Steps since the last coverage sample was taken. */
  sinceSample: number;
  /** Per-tile coverage of the last SETTLE_SAMPLES + 1 samples, a ring. */
  readonly history: Float32Array[];
  /** Samples in `history` this growth phase, and the slot the next one goes in. */
  samples: number;
  next: number;
  /** Consecutive samples that found every tile still. */
  still: number;
}

export const createCycle = (): Cycle => ({
  phase: "grow",
  steps: 0,
  seconds: 0,
  sinceSample: 0,
  history: Array.from({ length: SETTLE_SAMPLES + 1 }, () => new Float32Array(STATS_TILES)),
  samples: 0,
  next: 0,
  still: 0,
});

const enter = (c: Cycle, phase: CyclePhase) => {
  c.phase = phase;
  c.steps = 0;
  c.seconds = 0;
  c.samples = 0;
  c.still = 0;
};

/** Back to growing from fresh seed spots. */
export function restartCycle(c: Cycle): void {
  enter(c, "grow");
  c.sinceSample = 0;
}

/**
 * Extra kill rate at `x` (0..1 across the grid) for a retreat front at `front`
 * half-widths from the centre line: RETREAT_KILL behind it, ramping to 0 over
 * FRONT_BAND ahead. The shader computes the same.
 */
export function retreatKill(x: number, front: number): number {
  const d = Math.abs(x - 0.5) * 2;
  return RETREAT_KILL * Math.min(1, Math.max(0, (front - d) / FRONT_BAND));
}

/** Steps the front takes to sweep from the centre past the side edges. */
export const retreatSteps = (gridW: number) =>
  Math.max(1, Math.ceil(RETREAT_STEPS_PER_CELL * (gridW / 2) * (1 + FRONT_BAND)));

/**
 * Front position for the shader, in half-widths from the centre line: cells
 * closer than `front` get the full extra kill, fading out over FRONT_BAND. Far
 * negative (no effect) while growing or holding.
 */
export function cycleFront(c: Cycle, gridW: number): number {
  if (c.phase === "retreat") return (c.steps / retreatSteps(gridW)) * (1 + FRONT_BAND);
  if (c.phase === "clear") return 1 + FRONT_BAND;
  return -1;
}

/**
 * Advances the cycle by `steps` simulation steps and `dt` seconds. Returns true
 * when the grid should be reseeded (the caller reseeds and calls `restartCycle`).
 * With `enabled` false the pattern just grows and stays.
 */
export function advanceCycle(
  c: Cycle,
  steps: number,
  dt: number,
  gridW: number,
  holdSeconds: number,
  enabled: boolean,
): boolean {
  if (!enabled) {
    if (c.phase !== "grow") enter(c, "grow");
    c.steps += steps;
    c.sinceSample += steps;
    return false;
  }
  c.steps += steps;
  c.sinceSample += steps;
  // Paused (speed 0) means paused: phase time only counts while stepping.
  if (steps > 0) c.seconds += dt;
  switch (c.phase) {
    case "grow":
      if (c.seconds >= GROW_FALLBACK_SECONDS) enter(c, "hold");
      break;
    case "hold":
      if (c.seconds >= holdSeconds) enter(c, "retreat");
      break;
    case "retreat":
      if (c.steps >= retreatSteps(gridW)) enter(c, "clear");
      break;
    case "clear":
      if (c.steps >= CLEAR_FALLBACK_STEPS) return true;
      break;
  }
  return false;
}

/** Whether a coverage sample is due: growing or clearing, every SAMPLE_STEPS. */
export const wantsSample = (c: Cycle) =>
  (c.phase === "grow" || c.phase === "clear") && c.sinceSample >= SAMPLE_STEPS;

/** One coverage readback, from `readStats`. */
export interface Stats {
  /** Fraction of the grid's cells above COVER_B. */
  coverage: number;
  /** Largest B anywhere. */
  maxB: number;
  /** Covered fraction of each stats tile (-1 for tiles past the grid's edge). */
  readonly tiles: Float32Array;
}

export const createStats = (): Stats => ({
  coverage: 0,
  maxB: 0,
  tiles: new Float32Array(STATS_TILES),
});

/**
 * Feeds a coverage sample to the cycle. Returns true when the grid should be
 * reseeded: it has cleared after a retreat, or the pattern died out by itself
 * while growing.
 */
export function sampleCycle(c: Cycle, stats: Stats, enabled: boolean): boolean {
  c.sinceSample = 0;
  if (!enabled) return false;
  if (c.phase === "clear") return stats.maxB < EMPTY_B;
  if (c.phase !== "grow") return false;
  if (stats.maxB < EMPTY_B && c.steps > SAMPLE_STEPS) return true;
  // The oldest kept sample, then this one over it.
  const oldest = c.history[c.next];
  const full = c.samples > SETTLE_SAMPLES;
  let moving = 0;
  let tiles = 0;
  if (full) {
    for (let i = 0; i < STATS_TILES; i++) {
      if (stats.tiles[i] < 0) continue;
      tiles++;
      if (Math.abs(stats.tiles[i] - oldest[i]) > SETTLE_TILE_DELTA) moving++;
    }
  }
  const still = full && moving <= Math.max(1, Math.floor(tiles * SETTLE_MOVING_FRACTION));
  oldest.set(stats.tiles);
  c.next = (c.next + 1) % c.history.length;
  c.samples++;
  c.still = still && stats.coverage >= MIN_COVERAGE ? c.still + 1 : 0;
  if (c.still >= SETTLE_CHECKS) enter(c, "hold");
  return false;
}

/** Grid cells per stats texel along each axis, for a `w` x `h` grid. */
export const statsTile = (w: number, h: number): [number, number] => [
  Math.max(STATS_TILE_CELLS, Math.ceil(w / STATS_SIZE)),
  Math.max(STATS_TILE_CELLS, Math.ceil(h / STATS_SIZE)),
];

/**
 * Reads the stats texels (RGBA8 bytes, STATS_SIZE^2 of them: R = covered
 * fraction of the tile, G = its largest B, B = 255 if the tile holds any cells)
 * into `out`. Partial tiles at the far edges count as whole ones in the
 * coverage, which is close enough.
 */
export function readStats(bytes: Uint8Array, out: Stats): Stats {
  let sum = 0;
  let tiles = 0;
  let max = 0;
  for (let t = 0; t < STATS_TILES; t++) {
    const i = t * 4;
    if (bytes[i + 2] < 128) {
      out.tiles[t] = -1;
      continue;
    }
    const v = bytes[i] / 255;
    out.tiles[t] = v;
    sum += v;
    tiles++;
    if (bytes[i + 1] > max) max = bytes[i + 1];
  }
  out.coverage = tiles > 0 ? sum / tiles : 0;
  out.maxB = max / 255;
  return out;
}
