/**
 * Pure helpers for Forest Waterfall: the fall's layout and wobbling edges, the
 * free-fall speed profile its streak texture scrolls with, the tiling streak
 * texture itself, the light palettes and the spray particles at its foot.
 *
 * Everything is in reference px (1080 high), y down, in "local" coordinates where
 * the fall is on the left; the effect mirrors x for a fall on the right.
 */
import { clamp, fract } from "./math";
import { createNoise, createRng, fbmPeriodic2, hash32 } from "./noise";
import type { ForestLight } from "./waterfall.meta";

export const REF_HEIGHT = 1080;
/** Where the water leaves the ledge, and where it meets the pool. */
export const LEDGE_Y = 170;
export const POOL_Y = 815;
export const FALL_LENGTH = POOL_Y - LEDGE_Y;

/** Free fall: speed (reference px/s) as the water leaves the ledge, and gravity. */
export const FALL_V0 = 180;
export const FALL_GRAVITY = 450;

/** Water speed `s` px below the ledge: sqrt(v0^2 + 2 g s). Rises along the fall. */
export function fallSpeed(s: number): number {
  return Math.sqrt(FALL_V0 * FALL_V0 + 2 * FALL_GRAVITY * Math.max(s, 0));
}

/**
 * Seconds the water takes to fall `s` px from the ledge. The streak texture is
 * sampled at `travelTime(s) - t`, so each feature moves down at `fallSpeed` and
 * stretches as it speeds up.
 */
export function travelTime(s: number): number {
  return (fallSpeed(s) - FALL_V0) / FALL_GRAVITY;
}

/**
 * Edge wobble terms, two per edge: amplitude (px), spatial frequency (rad/px) and
 * angular speed (rad/s; negative runs the waves down the fall).
 */
export const WOBBLE = [
  [5, 0.011, -0.7],
  [3, 0.027, -1.3],
  [5, 0.013, -0.9],
  [3, 0.031, -1.1],
] as const;
/** Largest edge offset the wobble can reach. */
export const EDGE_WOBBLE = WOBBLE[0][0] + WOBBLE[1][0];
/** Extra margin around the band for the anti-aliased edge, reference px. */
export const EDGE_MARGIN = 3;

export interface FallLayout {
  /** Band centre, local x. */
  cx: number;
  /** Half width at the ledge and at the pool. */
  halfTop: number;
  halfBottom: number;
  /** Local x range that holds every pixel of the band, wobble and AA included. */
  minX: number;
  maxX: number;
}

export function createFallLayout(): FallLayout {
  return { cx: 0, halfTop: 0, halfBottom: 0, minX: 0, maxX: 0 };
}

/**
 * Places the fall in the outer part of the frame (the speaker covers the middle
 * third): centre at a fifth of the width, at most 380 px in. Flow widens it.
 */
export function fallLayout(out: FallLayout, refWidth: number, flow: number): FallLayout {
  const f = clamp(flow, 0, 1);
  const k = Math.min(1, refWidth / 1440);
  out.cx = Math.min(0.2 * refWidth, 380);
  out.halfTop = (24 + 34 * f) * k;
  out.halfBottom = out.halfTop * 1.35 + 6 * k;
  const reach = out.halfBottom + EDGE_WOBBLE + EDGE_MARGIN;
  out.minX = out.cx - reach;
  out.maxX = out.cx + reach;
  return out;
}

/** Writes the four wobble phases for time `t` (seconds), each wrapped to [0, 2 pi). */
export function wobblePhases(out: Float64Array, t: number): Float64Array {
  for (let i = 0; i < 4; i++) out[i] = fract((WOBBLE[i][2] * t) / (2 * Math.PI)) * 2 * Math.PI;
  return out;
}

/**
 * Left and right edge (local x) of the band `s` px below the ledge. Mirrors
 * `fallEdges` in the shader. The wobble grows from a steady lip to its full
 * amplitude at the pool.
 */
export function fallEdges(
  out: Float64Array,
  layout: FallLayout,
  s: number,
  phases: Float64Array,
): Float64Array {
  const f = clamp(s / FALL_LENGTH, 0, 1);
  const hw = layout.halfTop + (layout.halfBottom - layout.halfTop) * f;
  const g = 0.35 + 0.65 * f;
  const w = (i: number) => WOBBLE[i][0] * Math.sin(s * WOBBLE[i][1] + phases[i]);
  out[0] = layout.cx - hw + g * (w(0) + w(1));
  out[1] = layout.cx + hw + g * (w(2) + w(3));
  return out;
}

/** Streak texture size: narrow across the fall, long along it. */
export const STREAK_W = 64;
export const STREAK_H = 256;
/** Lattice period of both channels (cells per tile on each axis), and their octaves. */
export const STREAK_PERIODS = [8, 4] as const;
export const STREAK_OCTAVES = [3, 2] as const;
const STREAK_SEEDS = [0x51ea7, 0x2c0ff] as const;

/**
 * One channel of the streak texture at tile coordinates (u, v), each in tile
 * units: periodic fBm, so u and v both repeat every 1. The texture is square in
 * lattice cells but 4x taller in texels, and the shader stretches it further
 * along the fall: noise scaled anisotropically into long streaks.
 */
export function streakSample(
  noise: ReturnType<typeof createNoise>,
  channel: 0 | 1,
  u: number,
  v: number,
): number {
  const p = STREAK_PERIODS[channel];
  return fbmPeriodic2(noise, u * p, v * p, p, STREAK_OCTAVES[channel]);
}

/** RG8 streak texture, row-major, `STREAK_W` x `STREAK_H`, tiling on both axes. */
export function buildStreakTexture(): Uint8Array {
  const data = new Uint8Array(STREAK_W * STREAK_H * 2);
  for (const c of [0, 1] as const) {
    const noise = createNoise(STREAK_SEEDS[c]);
    for (let y = 0; y < STREAK_H; y++) {
      for (let x = 0; x < STREAK_W; x++) {
        const n = streakSample(noise, c, x / STREAK_W, y / STREAK_H);
        // fBm rarely nears +-1; stretch its middle so the threshold has range.
        const b = Math.round((clamp(n * 1.6, -1, 1) * 0.5 + 0.5) * 255);
        data[(y * STREAK_W + x) * 2 + c] = b;
      }
    }
  }
  return data;
}

/** Texture tiles per second the two streak lookups scroll at (along the fall). */
export const STREAK_RATES = [0.55, 0.35] as const;

/** Scroll phase of a lookup at time `t`: the tile offset, wrapped to [0, 1). */
export function scrollPhase(t: number, rate: number): number {
  return fract(t * rate);
}

type Rgb3 = readonly [number, number, number];

export interface ForestPalette {
  /** Light through the canopy at the top of the frame. */
  canopy: Rgb3;
  /** Shade deep in the forest, mid-frame. */
  deep: Rgb3;
  /** Distant trunks, hazy. */
  far: Rgb3;
  /** Near foliage silhouettes. */
  near: Rgb3;
  rock: Rgb3;
  moss: Rgb3;
  pool: Rgb3;
  /** Tint of the falling water's darker strands. */
  water: Rgb3;
  mist: Rgb3;
  shaft: Rgb3;
  /** Strength of the light shafts. */
  shaftGain: number;
}

export const PALETTES: Readonly<Record<ForestLight, ForestPalette>> = {
  morning: {
    canopy: [0.6, 0.72, 0.42],
    deep: [0.055, 0.11, 0.075],
    far: [0.28, 0.38, 0.3],
    near: [0.022, 0.055, 0.032],
    rock: [0.1, 0.105, 0.095],
    moss: [0.17, 0.28, 0.08],
    pool: [0.02, 0.06, 0.058],
    water: [0.66, 0.84, 0.82],
    mist: [0.78, 0.86, 0.8],
    shaft: [1, 0.88, 0.6],
    shaftGain: 0.3,
  },
  overcast: {
    canopy: [0.5, 0.56, 0.5],
    deep: [0.065, 0.095, 0.085],
    far: [0.3, 0.35, 0.33],
    near: [0.028, 0.048, 0.04],
    rock: [0.11, 0.115, 0.115],
    moss: [0.13, 0.2, 0.1],
    pool: [0.03, 0.055, 0.06],
    water: [0.7, 0.8, 0.82],
    mist: [0.7, 0.75, 0.75],
    shaft: [0.85, 0.9, 0.9],
    shaftGain: 0.06,
  },
  dusk: {
    canopy: [0.55, 0.4, 0.42],
    deep: [0.04, 0.05, 0.075],
    far: [0.2, 0.2, 0.27],
    near: [0.018, 0.024, 0.034],
    rock: [0.07, 0.07, 0.09],
    moss: [0.08, 0.11, 0.08],
    pool: [0.015, 0.025, 0.045],
    water: [0.56, 0.6, 0.72],
    mist: [0.52, 0.5, 0.62],
    shaft: [1, 0.62, 0.45],
    shaftGain: 0.2,
  },
};

/** Order of the colours in the packed palette (`uPal[i]` in the shaders). */
export const PALETTE_KEYS = [
  "canopy",
  "deep",
  "far",
  "near",
  "rock",
  "moss",
  "pool",
  "water",
  "mist",
  "shaft",
] as const;

/** Packs a palette as consecutive RGB triples in `PALETTE_KEYS` order. */
export function packPalette(p: ForestPalette): Float32Array {
  const out = new Float32Array(PALETTE_KEYS.length * 3);
  PALETTE_KEYS.forEach((key, i) => out.set(p[key], i * 3));
  return out;
}

/** Spray particles: the most there can be, and how many each unit of flow adds. */
export const MAX_SPRAY = 360;
/** Spray falls back under this gravity (px/s^2) and loses speed to drag (1/s). */
export const SPRAY_GRAVITY = 260;
export const SPRAY_DRAG = 1.3;
/** Largest sideways launch speed, px/s. Drag limits the drift to about this / drag. */
export const SPRAY_VX = 90;
/** The longest step `stepSpray` integrates in one go, so a stall can't fling particles. */
export const MAX_SPRAY_DT = 0.1;
/** A falling particle this far below the pool surface has dropped back in. */
export const SPRAY_SINK = 30;

export interface Spray {
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  age: Float64Array;
  life: Float64Array;
  /** Starting radius, px. */
  size: Float64Array;
  rng: () => number;
}

/** Live spray particles for a flow of `flow` (0..1). */
export function sprayCount(flow: number): number {
  return Math.round(MAX_SPRAY * (0.25 + 0.75 * clamp(flow, 0, 1)));
}

function spawn(s: Spray, i: number, layout: FallLayout): void {
  const r = s.rng;
  const across = r() * 2 - 1;
  s.x[i] = layout.cx + across * layout.halfBottom * 0.9;
  s.y[i] = POOL_Y - r() * 12;
  s.vx[i] = (across * 0.6 + (r() * 2 - 1) * 0.4) * SPRAY_VX;
  s.vy[i] = -(70 + r() * 190);
  s.life[i] = 0.9 + r() * 1.3;
  s.size[i] = 6 + r() * 10;
  s.age[i] = 0;
}

/**
 * Spray at the foot of `layout`'s fall, deterministic per seed. Every particle
 * starts part-way through a life, so the burst looks settled from the first frame.
 */
export function createSpray(seed: number, layout: FallLayout): Spray {
  const a = () => new Float64Array(MAX_SPRAY);
  const s: Spray = {
    x: a(),
    y: a(),
    vx: a(),
    vy: a(),
    age: a(),
    life: a(),
    size: a(),
    rng: createRng(hash32(seed + 0x5b7a)),
  };
  for (let i = 0; i < MAX_SPRAY; i++) {
    spawn(s, i, layout);
    const age = s.rng() * s.life[i];
    // Move it along its path to that age (drag-free is close enough here).
    s.x[i] += s.vx[i] * age * Math.exp(-SPRAY_DRAG * age * 0.5);
    s.y[i] += s.vy[i] * age + 0.5 * SPRAY_GRAVITY * age * age;
    s.vy[i] += SPRAY_GRAVITY * age;
    s.age[i] = age;
  }
  return s;
}

/**
 * Advances the spray by `dt` (clamped to `MAX_SPRAY_DT`): ballistic with drag,
 * ending early on dropping back into the pool. Particles below `count` respawn at the foot when their life ends; the rest
 * stay dead (age at or past life) until the flow rises again.
 */
export function stepSpray(s: Spray, dt: number, layout: FallLayout, count: number): void {
  const h = clamp(dt, 0, MAX_SPRAY_DT);
  if (h === 0) return;
  const damp = Math.exp(-SPRAY_DRAG * h);
  for (let i = 0; i < MAX_SPRAY; i++) {
    s.age[i] += h;
    if (s.age[i] >= s.life[i]) {
      if (i < count) spawn(s, i, layout);
      else continue;
    }
    s.vy[i] = (s.vy[i] + SPRAY_GRAVITY * h) * damp;
    s.vx[i] *= damp;
    s.x[i] += s.vx[i] * h;
    s.y[i] += s.vy[i] * h;
    // Back in the pool: done, and free to respawn.
    if (s.y[i] > POOL_Y + SPRAY_SINK && s.vy[i] > 0) s.age[i] = s.life[i];
  }
}

/** Opacity of a particle at life fraction `t`: a quick fade in, then a long fade out. */
export function sprayAlpha(t: number): number {
  if (t <= 0 || t >= 1) return 0;
  const fadeIn = Math.min(1, t / 0.15);
  const out = 1 - t;
  return fadeIn * out * Math.sqrt(out);
}
