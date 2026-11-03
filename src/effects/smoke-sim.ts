/**
 * Pure JS side of the incense smoke effect (smoke.ts): the source presets, the
 * fixed-step clock, the source splat, and a JS twin of the shader's velocity
 * field, which documents its maths and lets the tests check it.
 *
 * Coordinates are in "height units": x runs 0..aspect across the canvas and y
 * 0..1 from the bottom up, so features keep their shape at any aspect ratio.
 * Velocities are in height units per second.
 *
 * The velocity is upward buoyancy, plus a horizontal draft that grows with
 * height, plus the curl of a scalar stream function psi whose strength grows
 * above the source. Each part is divergence-free on its own (the curl of any
 * scalar field is; the draft depends only on y; buoyancy is constant), so the
 * advected smoke neither piles up nor thins out from the flow itself.
 */
import { clamp, smoothstep, wrap } from "./math";
import { type StepClock, takeSteps } from "./reaction-sim";
import type { SOURCE_OPTIONS } from "./smoke.meta";

/** Simulation steps per second, and the fixed step length. */
export const SIM_RATE = 60;
export const SIM_DT = 1 / SIM_RATE;
/** Most steps in one frame; a longer frame drops the rest (the smoke just slows). */
export const MAX_STEPS = 4;

/**
 * Fixed simulation steps to run for a frame of `dt` seconds: at most MAX_STEPS,
 * with the fractional step carried over in `clock.acc` (always in [0, 1)), so
 * neither a long frame nor a hidden tab builds a backlog.
 */
export function simSteps(clock: StepClock, dt: number): number {
  return takeSteps(clock, SIM_RATE, dt, MAX_STEPS);
}

/**
 * Waves of the stream function: wave vector (kx, ky) in radians per height unit,
 * the speed `c` each contributes at full strength (its amplitude is c / |k|, so
 * every wave adds the same order of velocity), and its angular speed as whole
 * laps per WAVE_PERIOD (so phases wrap seamlessly). ky < 0 with a positive
 * angular speed makes each wave's crests travel upward, like rising eddies.
 */
export const WAVES = [
  { kx: 7.5, ky: -5, c: 0.05, laps: 20, phase: 0.3 },
  { kx: -9, ky: -10.5, c: 0.04, laps: 27, phase: 2.1 },
  { kx: 16, ky: -14, c: 0.032, laps: 37, phase: 4.4 },
  { kx: -26, ky: -17, c: 0.024, laps: 46, phase: 1.2 },
] as const;
export const WAVE_COUNT = WAVES.length;
/** Seconds after which every wave phase repeats. */
export const WAVE_PERIOD = 240;

const TAU = Math.PI * 2;

/** Amplitude of wave `i` in the stream function (height units squared per second). */
export function waveAmp(i: number): number {
  const w = WAVES[i];
  return w.c / Math.hypot(w.kx, w.ky);
}

/** Writes each wave's phase at time `t` seconds (unwrapped), wrapped to [0, 2pi). */
export function wavePhases(t: number, out: Float32Array | Float64Array): void {
  for (let i = 0; i < WAVE_COUNT; i++) {
    const w = WAVES[i];
    // Laps per period are whole, so wrapping t first changes nothing but precision.
    const tw = wrap(t, 0, WAVE_PERIOD);
    out[i] = wrap((TAU * w.laps * tw) / WAVE_PERIOD + w.phase, 0, TAU);
  }
}

/** The velocity field's per-frame inputs, shared by the shader and the twin. */
export interface Flow {
  /** Upward buoyancy. */
  rise: number;
  /** Horizontal draft at the top of the canvas (it grows linearly from 0 at the bottom). */
  draft: number;
  /** Curl strength above the onset band (0..1 scales WAVES' speeds). */
  curl: number;
  /** Heights where the curl starts and reaches full strength. */
  onset0: number;
  onset1: number;
}

/** Full curl strength (multiplying WAVES' speeds) at turbulence 1 and 0. */
export const CURL_MAX = 1.6;
export const CURL_MIN = 0.35;

/**
 * Turbulence (0..1) to curl strength and onset: more turbulence breaks the
 * ribbon up sooner above the source at `sourceY`, and harder.
 */
export function turbulenceFlow(turbulence: number, sourceY: number, out: Flow): void {
  const t = clamp(turbulence, 0, 1);
  out.curl = CURL_MIN + (CURL_MAX - CURL_MIN) * t;
  out.onset0 = sourceY + 0.32 - 0.27 * t;
  out.onset1 = out.onset0 + 0.4;
}

/** Draft at the top of the canvas per unit of the `draft` param. */
export const DRAFT_SPEED = 0.08;
/** Slow wandering added to the draft, and its two periods (seconds). */
export const DRAFT_WANDER = 0.035;
const WANDER_A = 47;
const WANDER_B = 113;

/**
 * The draft at time `t` (seconds, unwrapped): the param's steady lean plus a
 * slow product of two sines, which is near zero most of the time and now and
 * then leans the column one way or the other.
 */
export function draftAt(draft: number, t: number): number {
  const wander = Math.sin((TAU * t) / WANDER_A) * Math.sin((TAU * t) / WANDER_B + 1);
  return clamp(draft, -1, 1) * DRAFT_SPEED + DRAFT_WANDER * wander;
}

/** Stream function psi at (x, y), for checking the velocity against its curl. */
export function streamFunction(x: number, y: number, phases: ArrayLike<number>, f: Flow): number {
  let sum = 0;
  for (let i = 0; i < WAVE_COUNT; i++) {
    const w = WAVES[i];
    sum += waveAmp(i) * Math.sin(w.kx * x + w.ky * y + phases[i]);
  }
  return f.curl * smoothstep(f.onset0, f.onset1, y) * sum;
}

/**
 * Velocity at (x, y), written to `out`: (dpsi/dy, -dpsi/dx) with psi =
 * S(y) * sum(a sin(k.p + phase)), plus the draft and buoyancy. Mirrors
 * `velocity` in smoke.ts.
 */
export function velocity(
  x: number,
  y: number,
  phases: ArrayLike<number>,
  f: Flow,
  out: Float64Array,
): void {
  let sinSum = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < WAVE_COUNT; i++) {
    const w = WAVES[i];
    const a = waveAmp(i);
    const th = w.kx * x + w.ky * y + phases[i];
    const c = Math.cos(th);
    sinSum += a * Math.sin(th);
    cx += a * w.kx * c;
    cy += a * w.ky * c;
  }
  const span = f.onset1 - f.onset0;
  const t = clamp((y - f.onset0) / span, 0, 1);
  const s = f.curl * t * t * (3 - 2 * t);
  const ds = (f.curl * 6 * t * (1 - t)) / span;
  out[0] = s * cy + ds * sinSum + f.draft * y;
  out[1] = -s * cx + f.rise;
}

/** Splat radius (height units) beyond which a source adds nothing, in radii. */
export const SPLAT_CUTOFF = 3;
const CUT = Math.exp(-0.5 * SPLAT_CUTOFF * SPLAT_CUTOFF);

/**
 * Source splat at offset (dx, dy) from a source: a Gaussian of `radius` around a
 * horizontal segment of half-width `halfWidth`, shifted and rescaled so it is
 * exactly 1 on the segment and falls to exactly 0 at SPLAT_CUTOFF radii. Mirrors
 * `splat` in smoke.ts.
 */
export function splat(dx: number, dy: number, halfWidth: number, radius: number): number {
  const ex = Math.max(Math.abs(dx) - halfWidth, 0);
  const q = (ex * ex + dy * dy) / (radius * radius);
  return Math.max(Math.exp(-0.5 * q) - CUT, 0) / (1 - CUT);
}

/**
 * Along a wide source (tea), output varies across the rim so several wisps rise
 * instead of a sheet: 1 - amount * (0.5 + 0.5 sin(k x + phase)), in [1 - amount, 1].
 */
export function wispFactor(x: number, k: number, phase: number, amount: number): number {
  return 1 - amount * (0.5 + 0.5 * Math.sin(k * x + phase));
}

export interface SourcePreset {
  /**
   * Emitters as (x offset from `sourceX` in height units, pointing away from the
   * canvas centre; tip height). One or two.
   */
  emitters: readonly (readonly [number, number])[];
  /** Half-width of each emitter's segment (0: a point). */
  halfWidth: number;
  /** Splat radius at 1080p, in height units. */
  radius: number;
  /** Buoyancy. */
  rise: number;
  /** Seconds for density to fall by e near the source (faster higher up). */
  life: number;
  /** Wisp modulation along the segment (see `wispFactor`). */
  wisp: number;
  /** Draws incense sticks with embers, or a cup. */
  prop: "sticks" | "cup";
}

export type SourceId = (typeof SOURCE_OPTIONS)[number]["value"];

export const SOURCES = {
  incense: {
    emitters: [[0, 0.36]],
    halfWidth: 0,
    radius: 0.0035,
    rise: 0.13,
    life: 6,
    wisp: 0,
    prop: "sticks",
  },
  two: {
    emitters: [
      [0, 0.36],
      [0.045, 0.31],
    ],
    halfWidth: 0,
    radius: 0.0035,
    rise: 0.13,
    life: 5,
    wisp: 0,
    prop: "sticks",
  },
  tea: {
    emitters: [[0, 0.215]],
    halfWidth: 0.04,
    radius: 0.006,
    rise: 0.09,
    life: 2.6,
    wisp: 0.85,
    prop: "cup",
  },
} as const satisfies Record<SourceId, SourcePreset>;

/** The preset for a select value; unknown values fall back to incense. */
export function sourceFor(id: string): SourcePreset {
  return Object.hasOwn(SOURCES, id) ? SOURCES[id as SourceId] : SOURCES.incense;
}

/** Margin kept between a source and the canvas sides, as a fraction of the width. */
export const SOURCE_MARGIN = 0.04;

/**
 * Emitter positions in height units, written to `out` as (x, y) pairs (one per
 * preset emitter): the first at `sourceX` (0..1 across the width), the second
 * offset away from the canvas centre. Returns the number of emitters.
 */
export function placeEmitters(
  preset: SourcePreset,
  sourceX: number,
  aspect: number,
  out: Float64Array,
): number {
  const x = clamp(sourceX, SOURCE_MARGIN, 1 - SOURCE_MARGIN) * aspect;
  const away = sourceX < 0.5 ? -1 : 1;
  const n = preset.emitters.length;
  for (let i = 0; i < n; i++) {
    const [dx, y] = preset.emitters[i];
    out[i * 2] = clamp(x + away * dx, 0, aspect);
    out[i * 2 + 1] = y;
  }
  return n;
}

/** Quality divisors: the field is smooth enough for 1/9 of the pixels by default. */
export const SMOKE_DIVISORS = { high: 2, balanced: 3, low: 4 } as const;
