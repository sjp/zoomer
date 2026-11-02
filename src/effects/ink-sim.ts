/**
 * Pure CPU-side logic for the ink-in-water effect: the plume lifecycle curves,
 * the drop scheduler (spacing, maximum alive, edge placement) and packing the
 * live plumes into the shader's uniform arrays. No GL here, so it is unit
 * tested directly. Allocates nothing per step.
 *
 * Positions are in frame heights (x from 0 to the aspect ratio, y up from 0 at
 * the bottom, as `vUv` in the shader), so a plume stays put across resizes.
 */
import { smoothstep, wrap } from "./math";

/** Most plumes alive at once. */
export const MAX_PLUMES = 3;
/** Seconds (at speed 1) from a drop landing to its plume fading out completely. */
export const PLUME_LIFE = 55;
/** Seconds the drop takes to appear: a quick, sharp start. */
export const FADE_IN = 0.8;
/** Age at which the plume starts fading; it reaches zero at `PLUME_LIFE`. */
export const FADE_START = 22;
/** Time constant of the unfurl: about 95% grown after 3 tau = 21 s. */
export const UNFURL_TAU = 7;
/** Seconds between drops at frequency 1. */
export const MIN_INTERVAL = 15;
export const MAX_INTERVAL = 40;
/** Distance of a drop's landing point inside the frame edge, in frame heights. */
export const EDGE_INSET = 0.05;

/** Radius at landing and fully unfurled, in frame heights, plus slow diffusion per second. */
const R0 = 0.012;
const R1 = 0.24;
const DIFFUSE = 0.0015;
/** How far the plume's centre sinks or drifts inwards while it unfurls (frame heights). */
const DRIFT = 0.14;
/** Edge softness of the density falloff, sharp at landing and soft when grown. */
const SOFT0 = 0.08;
const SOFT1 = 0.55;
/** Stretch along the drift direction when grown. */
const ELONG = 0.7;
/** Warp amplitudes per unit turbulence, as a fraction of the radius. */
const WARP1 = 0.9;
const WARP2 = 0.35;
/** Upper bound of |warp()| in the shader: |n.xy + 0.5 n.zw| with each n in [-0.5, 0.5]. */
export const WARP_BOUND = 1.07;
/** Noise drift of the coarse and fine warps, in texture units per second. */
const FLOW1 = 0.0035;
const FLOW2 = 0.006;
/** Swirl rate range of the coarse warp, in radians per second. */
const SPIN_MIN = 0.01;
const SPIN_MAX = 0.025;

export const EDGE_LEFT = 0;
export const EDGE_RIGHT = 1;
export const EDGE_TOP = 2;
export const EDGE_BOTTOM = 3;

/** Cumulative edge weights: mostly the sides, some top, a few from the bottom. */
const EDGE_CDF = [0.35, 0.7, 0.9, 1] as const;

export interface Plume {
  alive: boolean;
  /** Seconds since landing (speed-scaled). */
  age: number;
  edge: number;
  /** Position along the edge, 0..1 (of the height for sides, the width for top and bottom). */
  along: number;
  /** Drift direction, radians (0 = +x). */
  angle: number;
  /** Noise offsets of the coarse and fine warps, texture units. */
  seed1x: number;
  seed1y: number;
  seed2x: number;
  seed2y: number;
  /** Swirl rate, radians per second (signed). */
  spin: number;
  /** Ink colour index. */
  color: number;
}

export interface DropState {
  readonly plumes: Plume[];
  /** Seconds (at frequency 1) until the next drop may land. */
  timer: number;
  lastEdge: number;
  /** Drops landed so far; picks each one's colour. */
  spawned: number;
}

export function createDropState(): DropState {
  const plumes: Plume[] = [];
  for (let i = 0; i < MAX_PLUMES; i++) {
    plumes.push({
      alive: false,
      age: 0,
      edge: 0,
      along: 0,
      angle: 0,
      seed1x: 0,
      seed1y: 0,
      seed2x: 0,
      seed2y: 0,
      spin: 0,
      color: 0,
    });
  }
  return { plumes, timer: 0, lastEdge: -1, spawned: 0 };
}

/**
 * Density multiplier over a plume's life: 0 at landing, up to 1 within `FADE_IN`,
 * held while it unfurls, then a slow fade to exactly 0 at `PLUME_LIFE`.
 * Continuous everywhere; 0 outside [0, PLUME_LIFE].
 */
export function plumeIntensity(age: number): number {
  if (!(age > 0) || age >= PLUME_LIFE) return 0;
  return smoothstep(0, FADE_IN, age) * (1 - smoothstep(FADE_START, PLUME_LIFE, age));
}

/** How unfurled a plume is: 0 at landing, rising towards 1 (monotonic). */
export function plumeGrowth(age: number): number {
  return age > 0 ? 1 - Math.exp(-age / UNFURL_TAU) : 0;
}

/** Plume radius in frame heights. */
export function plumeRadius(age: number): number {
  const a = Math.max(0, age);
  return R0 + (R1 - R0) * plumeGrowth(a) + DIFFUSE * a;
}

/** Seconds (at frequency 1) until the next drop, in [MIN_INTERVAL, MAX_INTERVAL). */
export function spawnInterval(rng: () => number): number {
  return MIN_INTERVAL + (MAX_INTERVAL - MIN_INTERVAL) * rng();
}

export function aliveCount(state: DropState): number {
  let n = 0;
  for (const p of state.plumes) if (p.alive) n++;
  return n;
}

function pickEdge(rng: () => number): number {
  const r = rng();
  let e = 0;
  while (e < EDGE_CDF.length - 1 && r >= EDGE_CDF[e]) e++;
  return e;
}

/**
 * Lands a new drop at `age` in a free slot, at a random edge position (a
 * different edge from the last drop where possible), and returns it; null when
 * `MAX_PLUMES` are already alive.
 */
export function spawnPlume(
  state: DropState,
  rng: () => number,
  inks: number,
  age = 0,
): Plume | null {
  let slot: Plume | null = null;
  for (const p of state.plumes) {
    if (!p.alive) {
      slot = p;
      break;
    }
  }
  if (!slot) return null;
  let edge = pickEdge(rng);
  if (edge === state.lastEdge) edge = pickEdge(rng);
  state.lastEdge = edge;
  let base: number;
  if (edge === EDGE_LEFT || edge === EDGE_RIGHT) {
    slot.along = 0.15 + 0.7 * rng();
    // Inwards, leaning downwards: the ink sinks.
    base = edge === EDGE_LEFT ? -0.35 : Math.PI + 0.35;
  } else {
    // Top and bottom drops land in the outer thirds, clear of the speaker.
    const t = rng();
    slot.along = t < 0.5 ? 0.04 + 0.52 * t : 0.7 + 0.52 * (t - 0.5);
    base = edge === EDGE_TOP ? -Math.PI / 2 : Math.PI / 2;
  }
  slot.edge = edge;
  slot.angle = base + (rng() - 0.5) * 0.8;
  slot.seed1x = rng();
  slot.seed1y = rng();
  slot.seed2x = rng();
  slot.seed2y = rng();
  slot.spin = (rng() < 0.5 ? -1 : 1) * (SPIN_MIN + (SPIN_MAX - SPIN_MIN) * rng());
  slot.color = state.spawned % Math.max(1, Math.floor(inks));
  slot.age = age;
  slot.alive = true;
  state.spawned++;
  return slot;
}

/**
 * Starts the effect mid-scene rather than on empty water: one plume already
 * unfurling and the next drop a few seconds away.
 */
export function seedDrops(state: DropState, rng: () => number, inks: number): void {
  for (const p of state.plumes) p.alive = false;
  spawnPlume(state, rng, inks, 12);
  state.timer = 4 + 4 * rng();
}

/**
 * Advances every plume by `sdt` (speed-scaled seconds), retiring finished ones,
 * and lands a drop when the timer runs out and a slot is free. `frequency`
 * scales how fast the timer runs, so drops come `frequency` times as often.
 * While all slots are busy the timer waits at zero; the next drop then lands
 * as soon as one frees, and the timer restarts from a full interval.
 */
export function stepDrops(
  state: DropState,
  sdt: number,
  frequency: number,
  inks: number,
  rng: () => number,
): void {
  const step = Math.max(0, sdt);
  for (const p of state.plumes) {
    if (!p.alive) continue;
    p.age += step;
    if (p.age >= PLUME_LIFE) p.alive = false;
  }
  state.timer = Math.max(0, state.timer - step * Math.max(0, frequency));
  if (state.timer <= 0 && step > 0 && spawnPlume(state, rng, inks)) {
    state.timer = spawnInterval(rng);
  }
}

/** Landing point of a plume in frame heights, for a frame `aspect` heights wide. */
export function landingPoint(p: Plume, aspect: number, out: Float32Array, o = 0): void {
  if (p.edge === EDGE_LEFT || p.edge === EDGE_RIGHT) {
    out[o] = p.edge === EDGE_LEFT ? EDGE_INSET : aspect - EDGE_INSET;
    out[o + 1] = p.along;
  } else {
    out[o] = p.along * aspect;
    out[o + 1] = p.edge === EDGE_TOP ? 1 - EDGE_INSET : EDGE_INSET;
  }
}

/** Uniform arrays for the shader, `MAX_PLUMES` vec4s each (see `packPlumes`). */
export interface PlumeUniforms {
  /** Centre x, y (frame heights), radius, intensity. */
  readonly p0: Float32Array;
  /** Coarse warp noise offset xy, fine warp noise offset xy (texture units, wrapped to [0, 1)). */
  readonly p1: Float32Array;
  /** Drift direction xy (unit), elongation, edge softness. */
  readonly p2: Float32Array;
  /** Coarse and fine warp amplitudes (frame heights), squared reach, swirl angle. */
  readonly p3: Float32Array;
  /** Ink colour index per packed plume. */
  readonly color: Uint8Array;
}

export function createPlumeUniforms(): PlumeUniforms {
  return {
    p0: new Float32Array(MAX_PLUMES * 4),
    p1: new Float32Array(MAX_PLUMES * 4),
    p2: new Float32Array(MAX_PLUMES * 4),
    p3: new Float32Array(MAX_PLUMES * 4),
    color: new Uint8Array(MAX_PLUMES),
  };
}

/**
 * Writes the visible plumes into the first entries of `u` and returns how many.
 * `reach` (p3.z, squared) bounds how far from the centre the warped plume can
 * have any density, so the shader skips its fetches beyond it.
 */
export function packPlumes(
  state: DropState,
  aspect: number,
  turbulence: number,
  u: PlumeUniforms,
): number {
  const turb = Math.max(0, turbulence);
  let n = 0;
  for (const p of state.plumes) {
    const intensity = p.alive ? plumeIntensity(p.age) : 0;
    if (intensity <= 0) continue;
    const o = n * 4;
    const g = plumeGrowth(p.age);
    const r = plumeRadius(p.age);
    const dx = Math.cos(p.angle);
    const dy = Math.sin(p.angle);
    landingPoint(p, aspect, u.p0, o);
    u.p0[o] += dx * DRIFT * g;
    u.p0[o + 1] += dy * DRIFT * g;
    u.p0[o + 2] = r;
    u.p0[o + 3] = intensity;
    u.p1[o] = wrap(p.seed1x + p.age * FLOW1, 0, 1);
    u.p1[o + 1] = wrap(p.seed1y + p.age * FLOW1 * 0.7, 0, 1);
    u.p1[o + 2] = wrap(p.seed2x - p.age * FLOW2 * 0.6, 0, 1);
    u.p1[o + 3] = wrap(p.seed2y + p.age * FLOW2, 0, 1);
    const elong = 1 + ELONG * g;
    u.p2[o] = dx;
    u.p2[o + 1] = dy;
    u.p2[o + 2] = elong;
    u.p2[o + 3] = SOFT0 + (SOFT1 - SOFT0) * g;
    const amp1 = turb * WARP1 * r;
    const amp2 = turb * WARP2 * r;
    const reach = r * elong + WARP_BOUND * (amp1 + amp2) + 0.005;
    u.p3[o] = amp1;
    u.p3[o + 1] = amp2;
    u.p3[o + 2] = reach * reach;
    u.p3[o + 3] = p.spin * p.age;
    u.color[n] = p.color;
    n++;
  }
  return n;
}
