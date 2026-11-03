/**
 * Pure model for the "Rocky shore" effect: the rock silhouette, the wave queue
 * (each wave a scripted swell that rolls in, breaks and surges up the rocks, on
 * the shared `wash.ts` timeline), the per-column sea table the shader reads, the
 * low-res foam field (splatted by each break, drained and decayed), the spray
 * particles, and the sky palettes.
 *
 * Screen space in height units: y up from the bottom of the frame (0..1), x from
 * the left edge (0..aspect). The rocks stand in front of the sea; the still water
 * meets them at WATER_Y. A swell `n` world units seaward of the rocks (n < 0 on
 * the wash timeline) shows at HORIZON - CAMERA_K / (1 - n).
 */
import { hexToUnitRgb, type Rgb } from "./color";
import { clamp, smoothstep } from "./math";
import { createNoise, createRng } from "./noise";
import { MAX_PERIOD, MIN_PERIOD } from "./shore.meta";
import { T_ACTIVE, T_APPROACH, T_STOP, washFront } from "./wash";

/** Horizon height (height units). */
export const HORIZON = 0.6;
/** Where the still water meets the rocks (height units). */
export const WATER_Y = 0.2;
/** Camera constant: a swell z world units away sits CAMERA_K / z below the horizon. */
export const CAMERA_K = HORIZON - WATER_Y;
/** Distance seaward of the rocks where a swell breaks, and where it starts its approach. */
export const BREAK = 0.15;
export const APPROACH_DIST = 2.2;

// ---------------------------------------------------------------------------
// Rocks

/** Columns in the rock table across the frame. */
export const ROCK_COLUMNS = 2048;
/** Floats per rock column: height, slope (dh/dx). */
export const ROCK_FLOATS = 2;
/** Height of the rock shelf between boulders, below the water line so the sea shows in the gaps. */
export const ROCK_BASE = 0.15;
/** Tallest a rock may stand anywhere (height units). */
export const ROCK_MAX = 0.52;
/** Boulders in the middle third stay below this, clear of the speaker. */
export const ROCK_MIDDLE_MAX = 0.27;

/**
 * Rock silhouette for a frame `aspect` wide: column i (at x = (i + 0.5) / ROCK_COLUMNS
 * * aspect) gets its height and slope in `out` (ROCK_FLOATS per column). A low
 * shelf of rounded boulders runs along the bottom, rising to a taller stack at
 * the named side ("left" or "right"), or medium rocks at both ends ("across").
 * Unknown layouts fall back to "right". Deterministic per seed.
 */
export function fillRockTable(
  out: Float32Array,
  aspect: number,
  layout: string,
  seed: number,
): Float32Array {
  const a = Math.max(aspect, 0.2);
  const n = ROCK_COLUMNS;
  const dx = a / n;
  const rng = createRng(Math.floor(seed) * 7919 + 101);
  const noise = createNoise(Math.floor(seed) + 31);
  const h = out;
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) * dx;
    h[i * ROCK_FLOATS] = ROCK_BASE + 0.012 * noise.noise2(x * 6, 0.5);
  }
  /** How strongly the layout raises rocks at x: 1 at a tall side, 0 in the middle. */
  const side = (x: number) => {
    const fromLeft = 1 - smoothstep(0.04, 0.55, x);
    const fromRight = 1 - smoothstep(0.04, 0.55, a - x);
    if (layout === "left") return fromLeft;
    if (layout === "across") return 0.55 * Math.max(fromLeft, fromRight);
    return fromRight;
  };
  let x = -0.06 + 0.04 * rng();
  while (x < a + 0.08) {
    const wl = 0.04 + 0.07 * rng();
    const wr = 0.04 + 0.07 * rng();
    const e = side(x);
    let top = 0.17 + 0.07 * rng() + e * (0.16 + 0.14 * rng());
    // Leave room for the craggy detail added below.
    if (Math.abs(x - a / 2) < a / 6) top = Math.min(top, ROCK_MIDDLE_MAX - 0.015);
    top = Math.min(top, ROCK_MAX - 0.04);
    const bluntness = 0.25 + 0.2 * rng();
    const i0 = Math.max(0, Math.floor((x - wl) / dx));
    const i1 = Math.min(n - 1, Math.ceil((x + wr) / dx));
    for (let i = i0; i <= i1; i++) {
      const cx = (i + 0.5) * dx - x;
      const u = cx < 0 ? cx / wl : cx / wr;
      if (u <= -1 || u >= 1) continue;
      const v = ROCK_BASE + (top - ROCK_BASE) * Math.pow(1 - u * u, bluntness);
      const o = i * ROCK_FLOATS;
      if (v > h[o]) h[o] = v;
    }
    // Neighbours overlap a little, or leave a gap for the foam to drain through.
    x += (wl + wr) * (0.55 + 0.6 * rng());
  }
  // Craggy detail on top of the smooth boulders.
  for (let i = 0; i < n; i++) {
    const xx = (i + 0.5) * dx;
    const o = i * ROCK_FLOATS;
    const lift = h[o] - ROCK_BASE;
    const v = h[o] + lift * (0.06 * noise.noise2(xx * 18, 3.1) + 0.03 * noise.noise2(xx * 55, 7.7));
    h[o] = Math.min(v, ROCK_MAX);
  }
  for (let i = 0; i < n; i++) {
    const l = h[Math.max(0, i - 1) * ROCK_FLOATS];
    const r = h[Math.min(n - 1, i + 1) * ROCK_FLOATS];
    const span = (Math.min(n - 1, i + 1) - Math.max(0, i - 1)) * dx;
    h[i * ROCK_FLOATS + 1] = (r - l) / span;
  }
  return out;
}

/** Rock height at x (height units), linearly interpolated as the shader's filtered fetch. */
export function rockHeight(table: Float32Array, aspect: number, x: number): number {
  const f = clamp((x / Math.max(aspect, 0.2)) * ROCK_COLUMNS - 0.5, 0, ROCK_COLUMNS - 1);
  const i = Math.min(ROCK_COLUMNS - 2, Math.floor(f));
  const t = f - i;
  return table[i * ROCK_FLOATS] * (1 - t) + table[(i + 1) * ROCK_FLOATS] * t;
}

// ---------------------------------------------------------------------------
// Waves

/** A wave's run-up (height units above WATER_Y) is (REACH_MIN + REACH_SPAN * swell) * size. */
export const REACH_MIN = 0.03;
export const REACH_SPAN = 0.26;
/** Each wave's size factor lies in [SIZE_MIN, 1). */
export const SIZE_MIN = 0.7;
/** Seconds the break takes to peel from one side of the frame to the other. */
export const PEEL_MIN = 1.5;
export const PEEL_MAX = 3;
/** Each spacing is the period times a factor in [SPACING_MIN, SPACING_MAX), mean 1. */
export const SPACING_MIN = 0.85;
export const SPACING_MAX = 1.15;
/** A wave's life on the scheduler clock, the latest-peeling point included. */
export const LIFETIME = T_ACTIVE + PEEL_MAX;
/** Wave slots: LIFETIME fits within MAX_WAVES of the shortest spacings. */
export const MAX_WAVES = Math.ceil(LIFETIME / (MIN_PERIOD * SPACING_MIN)) + 1;

export interface ShoreWave {
  /** Start time on the scheduler clock (s). */
  start: number;
  /** Size factor in [SIZE_MIN, 1). */
  size: number;
  /** +1: the break peels from the left edge to the right; -1: from the right. */
  peelDir: number;
  /** Seconds the break takes to cross the frame. */
  peelSpan: number;
  /** Phase for this wave's foam irregularity. */
  phase: number;
  /** Fractional spray particles carried to the next frame. */
  sprayCarry: number;
}

export interface ShoreScheduler {
  /** Live waves, oldest first; only the first `count` are in flight. */
  readonly waves: readonly ShoreWave[];
  readonly count: number;
  /** Scheduler clock (s), unwrapped float64. */
  readonly time: number;
  /** Total waves spawned since the last reset. */
  readonly spawned: number;
  /** Advances the clock, retires finished waves and starts a new one when due. */
  step(dt: number, period: number): void;
  /** Clears every wave and restarts the clock with a new seed. */
  reset(seed: number): void;
}

export function createShoreScheduler(seed: number): ShoreScheduler {
  let rng = createRng(seed);
  const waves: ShoreWave[] = [];
  for (let i = 0; i < MAX_WAVES; i++) {
    waves.push({ start: 0, size: 1, peelDir: 1, peelSpan: PEEL_MIN, phase: 0, sprayCarry: 0 });
  }
  let count = 0;
  let time = 0;
  let spawned = 0;
  let nextAt = 0;

  const spawn = (period: number) => {
    const w = waves[count++];
    w.start = time;
    w.size = SIZE_MIN + (1 - SIZE_MIN) * rng();
    w.peelDir = rng() < 0.5 ? 1 : -1;
    w.peelSpan = PEEL_MIN + (PEEL_MAX - PEEL_MIN) * rng();
    w.phase = rng() * 100;
    w.sprayCarry = 0;
    spawned++;
    nextAt = time + period * (SPACING_MIN + (SPACING_MAX - SPACING_MIN) * rng());
  };

  return {
    waves,
    get count() {
      return count;
    },
    get time() {
      return time;
    },
    get spawned() {
      return spawned;
    },
    step(dt, period) {
      time += Math.max(0, dt);
      while (count > 0 && time - waves[0].start >= LIFETIME) {
        const done = waves[0];
        for (let i = 1; i < count; i++) waves[i - 1] = waves[i];
        waves[count - 1] = done;
        count--;
      }
      if (time >= nextAt && count < MAX_WAVES) {
        spawn(clamp(period, MIN_PERIOD, MAX_PERIOD));
      }
    },
    reset(s) {
      rng = createRng(s);
      count = 0;
      time = 0;
      spawned = 0;
      nextAt = 0;
    },
  };
}

/** Run-up of a wave (height units above WATER_Y) at a given swell. */
export function waveReach(w: ShoreWave, swell: number): number {
  return (REACH_MIN + REACH_SPAN * clamp(swell, 0, 1)) * w.size;
}

/** A wave's local clock at x: the break reaches x after a delay along its peel. */
export function waveTau(w: ShoreWave, time: number, x: number, aspect: number): number {
  const s = clamp(x / Math.max(aspect, 1e-3), 0, 1);
  return time - w.start - w.peelSpan * (w.peelDir > 0 ? s : 1 - s);
}

/** Water level at the rocks (height units) for a wave front n on the wash timeline. */
export function surgeLevel(front: number): number {
  return WATER_Y + Math.max(front, 0);
}

/** The approaching swell's strength: it builds as it nears, and is gone soon after the break. */
export function swellStrength(tau: number): number {
  return smoothstep(0, 1.5, tau) * (1 - smoothstep(T_APPROACH - 0.2, T_APPROACH + 0.6, tau));
}

/** Columns in the per-frame sea table. */
export const SEA_COLUMNS = 256;
/** Floats per sea column: surge height, swell y, swell half-thickness, swell strength. */
export const SEA_FLOATS = 4;
/** A swell's half-thickness (height units) one world unit away, per unit of reach. */
export const SWELL_THICK = 0.12;

/**
 * Fills the sea table for this frame: per column, the highest surge above
 * WATER_Y over all waves, and the strongest approaching swell's screen height,
 * half-thickness and strength. Returns `out`.
 */
export function fillSeaTable(
  sched: ShoreScheduler,
  aspect: number,
  swell: number,
  out: Float32Array,
): Float32Array {
  const a = Math.max(aspect, 1e-3);
  for (let c = 0; c < SEA_COLUMNS; c++) {
    const x = ((c + 0.5) / SEA_COLUMNS) * a;
    let surge = 0;
    let sy = 0;
    let thick = 0.01;
    let strength = 0;
    for (let i = 0; i < sched.count; i++) {
      const w = sched.waves[i];
      const tau = waveTau(w, sched.time, x, a);
      const reach = waveReach(w, swell);
      const f = washFront(tau, reach, BREAK, APPROACH_DIST);
      surge = Math.max(surge, surgeLevel(f) - WATER_Y);
      const s = swellStrength(tau);
      if (s > strength) {
        const z = Math.max(1 - f, 0.6);
        strength = s;
        sy = HORIZON - CAMERA_K / z;
        // Steepens as it nears: thicker for a bigger wave and nearer the rocks.
        thick = (SWELL_THICK * (0.02 + reach) * (0.5 + 0.5 * smoothstep(0, T_APPROACH, tau))) / z;
      }
    }
    const o = c * SEA_FLOATS;
    out[o] = surge;
    out[o + 1] = sy;
    out[o + 2] = thick;
    out[o + 3] = strength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Foam

/** The foam field covers y in [0, FOAM_TOP] in FOAM_ROWS square cells. */
export const FOAM_TOP = 0.6;
export const FOAM_ROWS = 72;
export const FOAM_CELL = FOAM_TOP / FOAM_ROWS;
/** Most columns the foam field uses, for very wide frames. */
export const MAX_FOAM_COLUMNS = 640;
/** The foam field steps at this fixed rate (s); it moves far less than a cell per step. */
export const FOAM_DT = 1 / 30;
/** Foam added per second at full splat weight. */
export const FOAM_RATE = 2.4;
/** Foam is splatted until this long after the run-up stops. */
export const SPLAT_AFTER_STOP = 0.6;
/** Water pouring over a rock covers this much of its face below the top (height units). */
export const OVERFLOW = 0.035;
/** Speed (height units / s) foam streams down a rock face, and sideways off a slope. */
export const DRAIN_ROCK = 0.035;
export const DRAIN_SIDE = 0.02;
/** Speed foam left above the falling water drops at. */
export const FALL = 0.09;
/** e-folding times (s): on a rock face, on the water, and left hanging above it. */
export const DECAY_ROCK = 2.4;
export const DECAY_WATER = 1.8;
export const DECAY_AIR = 0.7;
/** e-folding time (s) of the wet sheen the foam leaves on the rocks. */
export const WET_DECAY = 7;

export interface FoamField {
  readonly columns: number;
  readonly rows: number;
  /** Foam density per cell (row-major, row 0 at the bottom), 0..1. */
  readonly density: Float32Array;
  /** Wetness per cell, 0..1: follows the foam up at once and dries slowly. */
  readonly wet: Float32Array;
  /** RG8 upload buffer: density, wetness. */
  readonly bytes: Uint8Array;
  /** Seconds not yet stepped. */
  carry: number;
}

/** Foam columns for a frame `aspect` wide. */
export function foamColumns(aspect: number): number {
  return clamp(Math.ceil(Math.max(aspect, 1e-3) / FOAM_CELL), 1, MAX_FOAM_COLUMNS);
}

export function createFoamField(aspect: number): FoamField {
  const columns = foamColumns(aspect);
  const size = columns * FOAM_ROWS;
  return {
    columns,
    rows: FOAM_ROWS,
    density: new Float32Array(size),
    wet: new Float32Array(size),
    bytes: new Uint8Array(size * 2),
    carry: 0,
  };
}

/** Scratch shared by `stepFoam`, sized for the largest field. */
const scratch = new Float32Array(MAX_FOAM_COLUMNS * FOAM_ROWS);
const levels = new Float32Array(MAX_FOAM_COLUMNS);
const rocks = new Float32Array(MAX_FOAM_COLUMNS);
const slopes = new Float32Array(MAX_FOAM_COLUMNS);

/** Per-column streaming speed factor, so the drain splits into separate streams. */
export function streamFactor(x: number): number {
  return 0.55 + 0.45 * Math.sin(x * 61.7) * Math.sin(x * 23.3 + 1.3);
}

/**
 * One fixed step of the foam field: advects the foam (down rock faces and off
 * slopes, falling where the water has dropped away from it), decays it, splats
 * the waves' breaking surge into it, and updates the wet sheen. The field is
 * `aspect` wide; `rockTable` comes from `fillRockTable` for the same aspect.
 */
export function stepFoam(
  foam: FoamField,
  sched: ShoreScheduler,
  rockTable: Float32Array,
  aspect: number,
  swell: number,
  dt: number,
): void {
  const { columns: nc, rows: nr } = foam;
  const cell = FOAM_CELL;
  const src = foam.density;
  const dst = scratch;
  const kRock = Math.exp(-dt / DECAY_ROCK);
  const kWater = Math.exp(-dt / DECAY_WATER);
  const kAir = Math.exp(-dt / DECAY_AIR);
  const kWet = Math.exp(-dt / WET_DECAY);

  for (let c = 0; c < nc; c++) {
    const x = (c + 0.5) * cell;
    let level = WATER_Y;
    for (let i = 0; i < sched.count; i++) {
      const w = sched.waves[i];
      const tau = waveTau(w, sched.time, x, aspect);
      level = Math.max(
        level,
        surgeLevel(washFront(tau, waveReach(w, swell), BREAK, APPROACH_DIST)),
      );
    }
    levels[c] = level;
    rocks[c] = rockHeight(rockTable, aspect, x);
    const xl = rockHeight(rockTable, aspect, x - cell);
    const xr = rockHeight(rockTable, aspect, x + cell);
    slopes[c] = (xr - xl) / (2 * cell);
  }

  // Semi-Lagrangian advection: each cell pulls from upstream, bilinearly.
  for (let r = 0; r < nr; r++) {
    const y = (r + 0.5) * cell;
    for (let c = 0; c < nc; c++) {
      const x = (c + 0.5) * cell;
      const top = rocks[c];
      let vx = 0;
      let vy = 0;
      let k = kWater;
      if (y < top) {
        vy = -DRAIN_ROCK * streamFactor(x);
        // Near the top of a rock, foam slides off sideways, downhill into the gaps.
        const nearTop = 1 - smoothstep(0, 0.05, top - y);
        vx = -clamp(slopes[c], -1, 1) * DRAIN_SIDE * nearTop;
        k = kRock;
      } else if (y > levels[c] + cell) {
        vy = -FALL;
        k = kAir;
      }
      const sx = c - (vx * dt) / cell;
      const sy = r - (vy * dt) / cell;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const tx = sx - x0;
      const ty = sy - y0;
      const xa = x0 < 0 ? 0 : x0 >= nc ? nc - 1 : x0;
      const xb = x0 + 1 < 0 ? 0 : x0 + 1 >= nc ? nc - 1 : x0 + 1;
      // Nothing flows in from outside the field's top or bottom.
      const ra = y0 >= 0 && y0 < nr ? y0 * nc : -1;
      const rb = y0 + 1 >= 0 && y0 + 1 < nr ? (y0 + 1) * nc : -1;
      const a0 = ra < 0 ? 0 : src[ra + xa] * (1 - tx) + src[ra + xb] * tx;
      const a1 = rb < 0 ? 0 : src[rb + xa] * (1 - tx) + src[rb + xb] * tx;
      dst[r * nc + c] = (a0 * (1 - ty) + a1 * ty) * k;
    }
  }

  // Splat the breaking surge: foam fills the water from the rock top (a little
  // below, where it pours over) up to the surge level, thickest at the crest.
  for (let i = 0; i < sched.count; i++) {
    const w = sched.waves[i];
    const reach = waveReach(w, swell);
    for (let c = 0; c < nc; c++) {
      const x = (c + 0.5) * cell;
      const tau = waveTau(w, sched.time, x, aspect);
      if (tau < T_APPROACH - 0.2 || tau > T_STOP + SPLAT_AFTER_STOP) continue;
      const level = surgeLevel(washFront(tau, reach, BREAK, APPROACH_DIST));
      const top = rocks[c];
      // Behind a rock taller than the surge the water is hidden: spray only.
      if (top > level) continue;
      const fade =
        smoothstep(T_APPROACH - 0.2, T_APPROACH + 0.2, tau) *
        (1 - smoothstep(T_STOP - 1, T_STOP + SPLAT_AFTER_STOP, tau));
      const lumpy = 0.6 + 0.4 * Math.sin(x * 47 + w.phase) * Math.sin(x * 13 + w.phase * 0.7);
      const amount = FOAM_RATE * dt * fade * lumpy * (0.5 + 0.5 * swell);
      if (amount <= 0) continue;
      const lo = top - OVERFLOW;
      const r0 = Math.max(0, Math.floor(lo / cell));
      const r1 = Math.min(nr - 1, Math.floor(level / cell));
      for (let r = r0; r <= r1; r++) {
        const y = (r + 0.5) * cell;
        const weight =
          smoothstep(lo, lo + 0.025, y) * (0.4 + 0.6 * smoothstep(level - 0.06, level, y));
        const o = r * nc + c;
        const v = dst[o] + amount * weight;
        dst[o] = v > 1 ? 1 : v;
      }
    }
  }

  const wet = foam.wet;
  const bytes = foam.bytes;
  const size = nc * nr;
  for (let o = 0; o < size; o++) {
    const d = dst[o] < 1e-4 ? 0 : dst[o];
    src[o] = d;
    const wv = Math.max(wet[o] * kWet, d);
    wet[o] = wv;
    bytes[o * 2] = Math.round(d * 255);
    bytes[o * 2 + 1] = Math.round(wv * 255);
  }
}

/**
 * Advances the foam field by `dt` seconds in fixed FOAM_DT steps. The scheduler
 * must already be at the frame's time. Returns whether it stepped (and the
 * upload buffer changed).
 */
export function advanceFoam(
  foam: FoamField,
  sched: ShoreScheduler,
  rockTable: Float32Array,
  aspect: number,
  swell: number,
  dt: number,
): boolean {
  // A long stall (a hidden tab) shouldn't replay seconds of steps.
  foam.carry = Math.min(foam.carry + Math.max(0, dt), 4 * FOAM_DT);
  let stepped = false;
  while (foam.carry >= FOAM_DT) {
    foam.carry -= FOAM_DT;
    stepFoam(foam, sched, rockTable, aspect, swell, FOAM_DT);
    stepped = true;
  }
  return stepped;
}

// ---------------------------------------------------------------------------
// Spray

/** Most spray particles alive at once. */
export const MAX_SPRAY = 320;
/** Floats per particle in the pool: x, y, vx, vy, age, life, radius (px at 1080p). */
export const SPRAY_STATE = 7;
/** Floats per sprite instance: x px, y px (y up), radius px, alpha. */
export const SPRAY_FLOATS = 4;
/** Particles per height unit of frame width per second while the break passes. */
export const SPRAY_RATE = 45;
/** Seconds after the break at a point during which it throws spray. */
export const SPRAY_WINDOW = 1.2;
/** Gravity (height units / s²) and air drag (1 / s) on spray. */
export const SPRAY_GRAVITY = 0.32;
export const SPRAY_DRAG = 0.6;
/** Peak opacity of a spray droplet. */
export const SPRAY_ALPHA = 0.32;

export interface Spray {
  /** Particle pool, SPRAY_STATE floats each; the first `count` are alive. */
  readonly state: Float32Array;
  count: number;
}

export function createSpray(): Spray {
  return { state: new Float32Array(MAX_SPRAY * SPRAY_STATE), count: 0 };
}

/**
 * Spawns spray where each wave is breaking against the rocks (soft, rising a
 * little higher where a rock stands above the surge), then moves and retires the
 * particles. `rand` returns uniform [0, 1).
 */
export function stepSpray(
  spray: Spray,
  sched: ShoreScheduler,
  rockTable: Float32Array,
  aspect: number,
  swell: number,
  dt: number,
  rand: () => number,
): void {
  const st = spray.state;
  const a = Math.max(aspect, 1e-3);
  const sw = clamp(swell, 0, 1);
  // Move and retire.
  const drag = Math.exp(-SPRAY_DRAG * dt);
  let n = 0;
  for (let i = 0; i < spray.count; i++) {
    const o = i * SPRAY_STATE;
    const age = st[o + 4] + dt;
    if (age >= st[o + 5]) continue;
    const d = n * SPRAY_STATE;
    const vy = (st[o + 3] - SPRAY_GRAVITY * dt) * drag;
    const vx = st[o + 2] * drag;
    st[d] = st[o] + vx * dt;
    st[d + 1] = st[o + 1] + vy * dt;
    st[d + 2] = vx;
    st[d + 3] = vy;
    st[d + 4] = age;
    st[d + 5] = st[o + 5];
    st[d + 6] = st[o + 6];
    n++;
  }
  spray.count = n;

  // Spawn: the stretch of frame where each wave broke within the last SPRAY_WINDOW s.
  for (let i = 0; i < sched.count; i++) {
    const w = sched.waves[i];
    const t0 = waveTau(w, sched.time, 0, a);
    const t1 = waveTau(w, sched.time, a, a);
    // tau is linear in x: find where it lies in [T_APPROACH, T_APPROACH + SPRAY_WINDOW].
    let xa: number;
    let xb: number;
    if (t0 === t1) {
      if (t0 < T_APPROACH || t0 > T_APPROACH + SPRAY_WINDOW) continue;
      xa = 0;
      xb = a;
    } else {
      const ua = ((T_APPROACH - t0) / (t1 - t0)) * a;
      const ub = ((T_APPROACH + SPRAY_WINDOW - t0) / (t1 - t0)) * a;
      xa = clamp(Math.min(ua, ub), 0, a);
      xb = clamp(Math.max(ua, ub), 0, a);
    }
    if (xb <= xa) continue;
    w.sprayCarry += SPRAY_RATE * (0.4 + 0.6 * sw) * w.size * (xb - xa) * dt;
    const reach = waveReach(w, sw);
    while (w.sprayCarry >= 1) {
      w.sprayCarry -= 1;
      if (spray.count >= MAX_SPRAY) continue;
      const x = xa + (xb - xa) * rand();
      const tau = waveTau(w, sched.time, x, a);
      const level = surgeLevel(washFront(tau, reach, BREAK, APPROACH_DIST));
      const rock = rockHeight(rockTable, a, x);
      // Water striking a rock face throws spray higher than open surge.
      const impact = smoothstep(-0.02, 0.06, rock - level);
      const o = spray.count * SPRAY_STATE;
      st[o] = x;
      st[o + 1] = Math.max(rock, level) - 0.01;
      st[o + 2] = (rand() - 0.5) * 0.08;
      st[o + 3] = (0.06 + 0.12 * rand()) * (0.5 + 0.5 * sw) * (1 + 1.2 * impact);
      st[o + 4] = 0;
      st[o + 5] = 1.2 + 1.2 * rand();
      st[o + 6] = 2.5 + 4.5 * rand();
      spray.count++;
    }
  }
}

/** Opacity of a droplet `age` seconds into a `life`: a quick fade in, a long fade out. */
export function sprayAlpha(age: number, life: number): number {
  return SPRAY_ALPHA * smoothstep(0, 0.15, age) * (1 - smoothstep(0.35 * life, life, age));
}

/**
 * Writes the live droplets as sprite instances (SPRAY_FLOATS each) for a canvas
 * `height` px tall at `scale` (height / 1080). Returns the number written.
 */
export function writeSpray(spray: Spray, out: Float32Array, height: number, scale: number): number {
  const st = spray.state;
  for (let i = 0; i < spray.count; i++) {
    const o = i * SPRAY_STATE;
    const d = i * SPRAY_FLOATS;
    out[d] = st[o] * height;
    out[d + 1] = st[o + 1] * height;
    out[d + 2] = Math.max(st[o + 6] * scale, 1);
    out[d + 3] = sprayAlpha(st[o + 4], st[o + 5]);
  }
  return spray.count;
}

// ---------------------------------------------------------------------------
// Palettes

export type SkyId = "overcast" | "golden" | "morning";

export interface ShorePalette {
  skyTop: Rgb;
  skyHorizon: Rgb;
  seaFar: Rgb;
  seaNear: Rgb;
  /** The lit, translucent face of a surging wave. */
  face: Rgb;
  rock: Rgb;
  /** Sky light on the rocks' top edges. */
  rim: Rgb;
  foam: Rgb;
  /** Highlights on wet rock. */
  glint: Rgb;
  sun: Rgb;
  /** Sun glow centre (x as a share of the width, y in height units), size, strength. */
  sunX: number;
  sunY: number;
  sunSize: number;
  sunStrength: number;
}

const palette = (
  colors: Record<
    | "skyTop"
    | "skyHorizon"
    | "seaFar"
    | "seaNear"
    | "face"
    | "rock"
    | "rim"
    | "foam"
    | "glint"
    | "sun",
    string
  >,
  sun: { x: number; y: number; size: number; strength: number },
): ShorePalette => ({
  skyTop: hexToUnitRgb(colors.skyTop),
  skyHorizon: hexToUnitRgb(colors.skyHorizon),
  seaFar: hexToUnitRgb(colors.seaFar),
  seaNear: hexToUnitRgb(colors.seaNear),
  face: hexToUnitRgb(colors.face),
  rock: hexToUnitRgb(colors.rock),
  rim: hexToUnitRgb(colors.rim),
  foam: hexToUnitRgb(colors.foam),
  glint: hexToUnitRgb(colors.glint),
  sun: hexToUnitRgb(colors.sun),
  sunX: sun.x,
  sunY: sun.y,
  sunSize: sun.size,
  sunStrength: sun.strength,
});

export const PALETTES: Readonly<Record<SkyId, ShorePalette>> = {
  overcast: palette(
    {
      skyTop: "#7f8b96",
      skyHorizon: "#bfc5c9",
      seaFar: "#7a8892",
      seaNear: "#3b4a55",
      face: "#5f7a80",
      rock: "#1c1e21",
      rim: "#59616a",
      foam: "#e3e8eb",
      glint: "#c9d2d8",
      sun: "#dfe3e6",
    },
    { x: 0.3, y: 0.82, size: 0.35, strength: 0.12 },
  ),
  golden: palette(
    {
      skyTop: "#5d6a8c",
      skyHorizon: "#eab98a",
      seaFar: "#8c8a94",
      seaNear: "#33404f",
      face: "#6f7f78",
      rock: "#1d1817",
      rim: "#7a5a44",
      foam: "#fbefdd",
      glint: "#ffd8a0",
      sun: "#ffd49a",
    },
    { x: 0.72, y: 0.66, size: 0.12, strength: 0.75 },
  ),
  morning: palette(
    {
      skyTop: "#8fa9c4",
      skyHorizon: "#e4e1db",
      seaFar: "#8399aa",
      seaNear: "#3f5a6e",
      face: "#6a8c92",
      rock: "#202429",
      rim: "#66717c",
      foam: "#f2f6f8",
      glint: "#e8f0f6",
      sun: "#fff6e6",
    },
    { x: 0.25, y: 0.7, size: 0.2, strength: 0.35 },
  ),
};

/** The palette for a sky select value; unknown values fall back to "morning". */
export function paletteFor(sky: string): ShorePalette {
  return sky === "overcast" || sky === "golden" || sky === "morning"
    ? PALETTES[sky]
    : PALETTES.morning;
}
