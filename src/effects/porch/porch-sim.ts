/**
 * Porch Light Rain's GL-free simulation and geometry, kept here so it can be
 * tested: the lamp's light cone, a fixed pool of wrapping rain streaks, drips
 * that grow on the gutter and fall, and the splashes they make on landing.
 *
 * Everything is in reference px: a 1080-px-high frame, y down. `porch.ts` scales
 * to device px.
 */
import type { LampSide } from "./porch.meta";
import { clamp, smoothstep, wrap } from "../math";
import { createRng, hash32 } from "../noise";

export const REF_HEIGHT = 1080;

/** Porch roof: soffit boards above the fascia, then the gutter, whose bottom is the roof edge. */
export const FASCIA_TOP = 60;
export const GUTTER_TOP = 74;
export const GUTTER_BOTTOM = 100;

/** Lamp centre: distance in from the side, and height. */
const LAMP_INSET = 120;
const LAMP_Y = 168;
/** The cone axis leans this far (radians) from straight down, towards the middle. */
const CONE_TILT = 0.42;
/** Tangent of the cone's half-angle (about 40 degrees). */
export const CONE_TAN = 0.84;
/** Fraction of the half-angle that is fully lit before the soft edge. */
export const CONE_CORE = 0.3;
/** Distance (reference px) at which the lamp's light falls to half. */
export const LIGHT_R = 560;

/** Ground layout: the lawn's far edge and the top of the wet step. */
export const LAWN_Y = 790;
export const STEP_Y = 935;

/** Lamp position and unit cone axis, reference px. */
interface LampGeometry {
  x: number;
  y: number;
  ax: number;
  ay: number;
}

export function createLampGeometry(): LampGeometry {
  return { x: 0, y: 0, ax: 0, ay: 1 };
}

/** Places the lamp in the top corner on `side`, its cone leaning towards the middle. */
export function lampGeometry(out: LampGeometry, side: LampSide, refWidth: number): LampGeometry {
  const left = side !== "right";
  out.x = left ? LAMP_INSET : refWidth - LAMP_INSET;
  out.y = LAMP_Y;
  out.ax = (left ? 1 : -1) * Math.sin(CONE_TILT);
  out.ay = Math.cos(CONE_TILT);
  return out;
}

/**
 * The cone's angular mask at (x, y): 1 on the axis and in the core, easing to 0
 * at the cone's edge, 0 outside it and behind the lamp. Mirrors `coneMask` in
 * porch.ts's GLSL.
 */
export function coneMask(g: LampGeometry, x: number, y: number): number {
  const dx = x - g.x;
  const dy = y - g.y;
  const along = dx * g.ax + dy * g.ay;
  if (along < 0) {
    return 0;
  }
  const perp = Math.abs(dx * g.ay - dy * g.ax);
  const r = perp / Math.max(along * CONE_TAN, 1e-3);
  return 1 - smoothstep(CONE_CORE, 1, r);
}

/** The lamp's light at (x, y): the cone mask times an inverse-square-like falloff. */
export function lampLight(g: LampGeometry, x: number, y: number): number {
  const dx = x - g.x;
  const dy = y - g.y;
  return coneMask(g, x, y) / (1 + (dx * dx + dy * dy) / (LIGHT_R * LIGHT_R));
}

// ---------------------------------------------------------------- Rain

/** Most rain streaks (at rain = 1). */
export const MAX_RAIN = 520;
/** Rain enters from just under the roof, so the gutter (drawn later) hides its start. */
export const RAIN_TOP = GUTTER_BOTTOM - 60;
/** Far drops stop at the lawn's far edge, the nearest at the frame's bottom. */
const RAIN_FLOOR: readonly [number, number] = [LAWN_Y, REF_HEIGHT + 40];
/** Fall speed (reference px/s) of the farthest and nearest drops. */
const RAIN_SPEED: readonly [number, number] = [820, 1350];
/** Horizontal drift per unit fall at wind = ±1. */
export const RAIN_SLANT = 0.32;
/** Streaks run past the frame's sides by this much, so slanted rain enters from off-screen. */
export const RAIN_MARGIN = 200;

interface Rain {
  readonly count: number;
  /** Position across the frame plus margins, 0..1. */
  readonly u: Float32Array;
  /** Height of the streak's head, reference px, in `[RAIN_TOP, floor)`. */
  readonly y: Float32Array;
  /** 0 = far, 1 = near: sets speed, length, width, brightness and floor. */
  readonly depth: Float32Array;
  /** Per-drop brightness jitter. */
  readonly glint: Float32Array;
}

/** A fixed pool of `count` drops scattered evenly over their fall, seeded. */
export function createRain(seed: number, count: number): Rain {
  const rng = createRng(hash32(seed + 0x5a17));
  const u = new Float32Array(count);
  const y = new Float32Array(count);
  const depth = new Float32Array(count);
  const glint = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    u[i] = rng();
    // Mostly far drops, a few near ones.
    const d = rng();
    depth[i] = d * d;
    y[i] = RAIN_TOP + rng() * (rainFloor(depth[i]) - RAIN_TOP);
    glint[i] = 0.6 + 0.4 * rng();
  }
  return { count, u, y, depth, glint };
}

/** The height a drop of this depth wraps at. */
export function rainFloor(depth: number): number {
  return RAIN_FLOOR[0] + (RAIN_FLOOR[1] - RAIN_FLOOR[0]) * depth;
}

/** Fall speed of a drop of this depth, reference px/s. */
export function rainSpeed(depth: number): number {
  return RAIN_SPEED[0] + (RAIN_SPEED[1] - RAIN_SPEED[0]) * depth;
}

/**
 * Advances the first `n` drops by `dt` seconds. A drop leaving its floor wraps to
 * the top keeping its overshoot, so the stream has no gaps and the count never
 * changes. `span` is the width covered by `u` (frame width plus margins).
 */
export function stepRain(rain: Rain, n: number, dt: number, wind: number, span: number): void {
  const drift = (clamp(wind, -1, 1) * RAIN_SLANT) / Math.max(span, 1);
  const count = Math.min(n, rain.count);
  for (let i = 0; i < count; i++) {
    const d = rain.depth[i];
    const fall = rainSpeed(d) * dt;
    rain.y[i] = wrap(rain.y[i] + fall, RAIN_TOP, rainFloor(d) - RAIN_TOP);
    rain.u[i] = wrap(rain.u[i] + fall * drift, 0, 1);
  }
}

// ---------------------------------------------------------------- Drips

/** Drip points along the gutter. */
export const DRIP_COUNT = 7;
/** Seconds a drip takes to swell before it lets go, at the slowest rate. */
export const GROW_RANGE: readonly [number, number] = [1.6, 5.5];
/** Gravity for falling drips, reference px/s^2 (slow enough to read as big, heavy drops). */
const DRIP_GRAVITY = 760;
/** Where drips land: the wet step, a little apart in depth. */
const LAND_RANGE: readonly [number, number] = [STEP_Y + 25, STEP_Y + 115];
/** Longest step the drips take; a longer frame (a tab coming back) is clipped. */
export const MAX_DRIP_DT = 0.25;

export const GROWING = 0;
export const FALLING = 1;

interface Drips {
  readonly count: number;
  /** Position along the gutter, 0..1 of the frame width. */
  readonly u: Float32Array;
  readonly landY: Float32Array;
  readonly phase: Uint8Array;
  /** Growing: seconds swollen so far, in `[0, grow]`. Falling: unused. */
  readonly t: Float32Array;
  /** This cycle's swell time. */
  readonly grow: Float32Array;
  /** Falling: height (reference px) and speed. */
  readonly y: Float32Array;
  readonly vy: Float32Array;
  /** Landings so far per drip, which seeds the next cycle's swell time. */
  readonly landings: Uint32Array;
  readonly seed: number;
}

/** Deterministic swell time for drip `i`'s `n`-th cycle. */
export function growTime(seed: number, i: number, n: number): number {
  const h = hash32(hash32(hash32(seed + 0x3d1) ^ (i * 0x9e37)) ^ n) / 4294967296;
  return GROW_RANGE[0] + (GROW_RANGE[1] - GROW_RANGE[0]) * h;
}

/** Drip points spread unevenly along the gutter, each part-way through its first swell. */
export function createDrips(seed: number, count = DRIP_COUNT): Drips {
  const rng = createRng(hash32(seed + 0xd819));
  const d: Drips = {
    count,
    u: new Float32Array(count),
    landY: new Float32Array(count),
    phase: new Uint8Array(count),
    t: new Float32Array(count),
    grow: new Float32Array(count),
    y: new Float32Array(count),
    vy: new Float32Array(count),
    landings: new Uint32Array(count),
    seed,
  };
  for (let i = 0; i < count; i++) {
    // Stratified, so no two share a spot; the outer ones sit well inside the frame.
    d.u[i] = 0.04 + (0.92 * (i + 0.15 + 0.7 * rng())) / count;
    d.landY[i] = LAND_RANGE[0] + (LAND_RANGE[1] - LAND_RANGE[0]) * rng();
    d.grow[i] = growTime(seed, i, 0);
    d.t[i] = d.grow[i] * rng();
    d.phase[i] = GROWING;
    d.y[i] = GUTTER_BOTTOM;
  }
  return d;
}

interface Splashes {
  readonly max: number;
  readonly u: Float32Array;
  readonly y: Float32Array;
  /** Seconds since landing; at `SPLASH_LIFE` or more the slot is free. */
  readonly age: Float32Array;
  /** Per-splash random seed, for its droplets. */
  readonly seed: Uint32Array;
  /** Next slot to fill (a ring buffer, so the oldest goes first). */
  next: number;
  /** Splashes spawned so far. */
  spawned: number;
}

export const MAX_SPLASHES = 16;
export const SPLASH_LIFE = 0.7;

export function createSplashes(max = MAX_SPLASHES): Splashes {
  const age = new Float32Array(max).fill(SPLASH_LIFE);
  return {
    max,
    u: new Float32Array(max),
    y: new Float32Array(max),
    age,
    seed: new Uint32Array(max),
    next: 0,
    spawned: 0,
  };
}

function spawnSplash(s: Splashes, u: number, y: number, seed: number): void {
  const k = s.next;
  s.u[k] = u;
  s.y[k] = y;
  s.age[k] = 0;
  s.seed[k] = seed >>> 0;
  s.next = (k + 1) % s.max;
  s.spawned++;
}

export function stepSplashes(s: Splashes, dt: number): void {
  for (let i = 0; i < s.max; i++) {
    if (s.age[i] < SPLASH_LIFE) {
      s.age[i] += dt;
    }
  }
}

/**
 * Advances the drips by `dt` seconds (clipped to `MAX_DRIP_DT`), swelling at
 * `rate` times normal speed. A drip that lets go falls under gravity; one that
 * reaches its landing height spawns exactly one splash and starts its next
 * swell. Returns the number that landed.
 */
export function stepDrips(d: Drips, splashes: Splashes, dt: number, rate: number): number {
  const h = Math.min(Math.max(dt, 0), MAX_DRIP_DT);
  let landed = 0;
  for (let i = 0; i < d.count; i++) {
    if (d.phase[i] === GROWING) {
      d.t[i] += h * rate;
      if (d.t[i] >= d.grow[i]) {
        d.t[i] = d.grow[i];
        d.phase[i] = FALLING;
        d.y[i] = GUTTER_BOTTOM;
        d.vy[i] = 0;
      }
    } else {
      d.vy[i] += DRIP_GRAVITY * h;
      d.y[i] += d.vy[i] * h;
      if (d.y[i] >= d.landY[i]) {
        const n = d.landings[i]++;
        spawnSplash(splashes, d.u[i], d.landY[i], hash32(d.seed * 131 + i * 7919 + n));
        d.phase[i] = GROWING;
        d.t[i] = 0;
        d.grow[i] = growTime(d.seed, i, n + 1);
        d.y[i] = GUTTER_BOTTOM;
        d.vy[i] = 0;
        landed++;
      }
    }
  }
  return landed;
}

/** Splash droplets per splash. */
export const SPLASH_DROPS = 4;
const DROP_GRAVITY = 1400;

/**
 * Droplet `k` of a splash `age` seconds old: offset from the landing point
 * (reference px) written to `out`, and whether it is still in the air.
 */
export function splashDroplet(out: Float64Array, seed: number, k: number, age: number): boolean {
  const h = hash32(seed ^ (k * 0x2c1b3c6d));
  const side = k & 1 ? 1 : -1;
  const vx = side * (35 + ((h & 0xff) / 255) * 90);
  const vy = -(130 + (((h >>> 8) & 0xff) / 255) * 140);
  const dy = vy * age + 0.5 * DROP_GRAVITY * age * age;
  out[0] = vx * age;
  out[1] = dy;
  return age > 0 && dy < 0;
}
