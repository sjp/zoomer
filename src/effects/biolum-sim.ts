/**
 * Pure model for the "Bioluminescent shore" effect: the wave queue, each wave's
 * glow-energy curve and foam band, the wet sand it leaves, the shoreline layouts
 * and the uniform packing. The wash timeline itself comes from `wash.ts`.
 *
 * World units: the shore normal `n` is positive landward, with the still-water
 * line at n = 0, in units of the camera's distance to a "low" shoreline. The
 * shader mirrors `glowEnergy`, `foamWidth` and `biolumWetness`.
 */
import { createRng } from "./noise";
import { clamp, smoothstep } from "./math";
import { MAX_INTERVAL, MIN_INTERVAL } from "./biolum.meta";
import { T_ACTIVE, T_APPROACH, T_DRY, T_STOP, washFront, washSinceUncovered } from "./wash";

/** Horizon height (height units, y up). */
export const HORIZON = 0.58;
/**
 * Camera constant: a point `z` world units away sits K / z below the horizon. A
 * "low" shoreline (at y = 0.24) is then 1 unit away.
 */
export const CAMERA_K = HORIZON - 0.24;
/** Distance seaward of the shoreline where waves break. */
export const BREAK = 0.08;
/** Distance seaward where a swell line starts its approach. */
export const APPROACH_DIST = 1.4;

/** Each wave's run-up is a factor in [REACH_MIN, REACH_MAX). */
export const REACH_MIN = 0.1;
export const REACH_MAX = 0.17;
/** Seconds the break takes to peel from one side of the frame to the other. */
export const PEEL_MIN = 1.2;
export const PEEL_MAX = 2.5;
/** Each spacing is the interval times a factor in [SPACING_MIN, SPACING_MAX), mean 1. */
export const SPACING_MIN = 0.9;
export const SPACING_MAX = 1.1;
/** Seconds a wave stays in flight after draining, while its wet sand fades. */
export const WET_TAIL = 3;
/** Seconds over which the wet sand fades at the end of a wave (on its local clock). */
export const WET_FADE = 2.5;
/** A wave's whole life on the scheduler clock: the latest-peeling point included. */
export const LIFETIME = T_ACTIVE + PEEL_MAX + WET_TAIL;
/**
 * Wave slots. LIFETIME fits within MAX_WAVES of the shortest spacings, so a new
 * wave never has to wait for a slot.
 */
export const MAX_WAVES = 3;

/** Glow ramps up over [T_APPROACH - RISE_BEFORE, T_APPROACH + RISE_AFTER]: the break. */
export const RISE_BEFORE = 0.4;
export const RISE_AFTER = 0.35;
/** Share of the glow lost while the foam runs up the sand. */
export const RUNUP_LOSS = 0.3;
/** e-folding time (s) of the glow once the foam starts draining. */
export const GLOW_FADE = 1.2;
/** The glow's last tail is eased to exactly zero over [T_STOP + 1.5, GLOW_END]. */
export const GLOW_END = T_ACTIVE + 0.5;
/** Soft cap: summed glow g shows as 1 - exp(-GLOW_CAP * g). */
export const GLOW_CAP = 1.4;

/**
 * Glow energy (0..1) of a wave `tau` seconds into its local timeline: nothing on
 * the approach, a fast rise at the break, a slow loss while the foam runs up, then
 * an exponential fade as it drains, ending at exactly 0 by GLOW_END. Continuous.
 */
export function glowEnergy(tau: number): number {
  const rise = smoothstep(T_APPROACH - RISE_BEFORE, T_APPROACH + RISE_AFTER, tau);
  const linger = 1 - RUNUP_LOSS * smoothstep(T_APPROACH, T_STOP, tau);
  const drain = Math.exp(-Math.max(0, tau - T_STOP) / GLOW_FADE);
  const end = 1 - smoothstep(T_STOP + 1.5, GLOW_END, tau);
  return rise * linger * drain * end;
}

/** Width (world units) of the glowing foam band trailing the front: it spreads as it ages. */
export function foamWidth(tau: number): number {
  return 0.025 + 0.09 * smoothstep(T_APPROACH, T_ACTIVE, tau);
}

/** Position of a wave's front (n) on its local clock, for a run-up of `reach`. */
export function biolumFront(tau: number, reach: number): number {
  return washFront(tau, reach, BREAK, APPROACH_DIST);
}

/** Fade of a wave's wet sand at the end of its life, on its local clock. */
export function wetFade(tau: number): number {
  return 1 - smoothstep(T_ACTIVE + WET_TAIL - WET_FADE, T_ACTIVE + WET_TAIL, tau);
}

/**
 * Wetness (0..1) a wave leaves at `n`, `tau` seconds into its local timeline: wet
 * while covered, then drying with T_DRY once the drain uncovers it, and faded out
 * by T_ACTIVE + WET_TAIL.
 */
export function biolumWetness(n: number, tau: number, reach: number): number {
  const m = tau < T_STOP ? biolumFront(tau, reach) : reach;
  if (m <= 0 || n > m) {
    return 0;
  }
  const since = washSinceUncovered(n, tau, m);
  return Math.exp(-Math.max(0, since) / T_DRY) * wetFade(tau);
}

/** Summed glow as shown: monotonic, 0 at 0 and below 1, so overlapping waves never clip. */
export function capGlow(g: number): number {
  return 1 - Math.exp(-GLOW_CAP * Math.max(0, g));
}

export interface BiolumWave {
  /** Start time on the scheduler clock (s). */
  start: number;
  reach: number;
  /** +1: the break peels from the left edge to the right; -1: from the right. */
  peelDir: number;
  /** Seconds the break takes to cross the frame. */
  peelSpan: number;
  /** Foam noise offsets, so waves don't share a pattern. */
  offX: number;
  offY: number;
}

export interface BiolumScheduler {
  /** Live waves, oldest first; only the first `count` are in flight. */
  readonly waves: readonly BiolumWave[];
  readonly count: number;
  /** Scheduler clock (s), unwrapped float64. */
  readonly time: number;
  /** Total waves spawned since the last reset. */
  readonly spawned: number;
  /** Advances the clock, retires finished waves and starts a new one when due. */
  step: (dt: number, interval: number) => void;
  /** Clears every wave and restarts the clock with a new seed. */
  reset: (seed: number) => void;
}

export function createBiolumScheduler(seed: number): BiolumScheduler {
  let rng = createRng(seed);
  const waves: BiolumWave[] = [];
  for (let i = 0; i < MAX_WAVES; i++) {
    waves.push({ start: 0, reach: 0, peelDir: 1, peelSpan: PEEL_MIN, offX: 0, offY: 0 });
  }
  let count = 0;
  let time = 0;
  let spawned = 0;
  /** When the next wave is due; the first one starts straight away. */
  let nextAt = 0;

  const spawn = (interval: number) => {
    const w = waves[count++];
    w.start = time;
    w.reach = REACH_MIN + (REACH_MAX - REACH_MIN) * rng();
    w.peelDir = rng() < 0.5 ? 1 : -1;
    w.peelSpan = PEEL_MIN + (PEEL_MAX - PEEL_MIN) * rng();
    w.offX = rng();
    w.offY = rng();
    spawned++;
    nextAt = time + interval * (SPACING_MIN + (SPACING_MAX - SPACING_MIN) * rng());
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
    step(dt, interval) {
      time += Math.max(0, dt);
      // Waves share one lifetime, so they retire in start order from the front.
      while (count > 0 && time - waves[0].start >= LIFETIME) {
        const done = waves[0];
        for (let i = 1; i < count; i++) {
          waves[i - 1] = waves[i];
        }
        waves[count - 1] = done;
        count--;
      }
      // Never reached with valid intervals (see MAX_WAVES), but stay safe if one is.
      if (time >= nextAt && count < MAX_WAVES) {
        spawn(clamp(interval, MIN_INTERVAL, MAX_INTERVAL));
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

/** Floats per wave in the packed uniform array (two vec4s). */
export const WAVE_FLOATS = 8;

/**
 * Packs the live waves into `out` (WAVE_FLOATS per wave) for a frame `aspect`
 * (width / height) wide. A wave's local clock at x (height units) is
 * A.x - A.y * x, so the break sweeps across the frame in `peelSpan` seconds.
 *
 * - A: local time at x = 0, its slope per height unit, reach, unused.
 * - B: foam noise offsets, unused, unused.
 *
 * Returns the number of waves packed.
 */
export function packWaves(sched: BiolumScheduler, aspect: number, out: Float32Array): number {
  const n = sched.count;
  const a = Math.max(aspect, 1e-3);
  for (let i = 0; i < n; i++) {
    const w = sched.waves[i];
    const tau = sched.time - w.start;
    const o = i * WAVE_FLOATS;
    // Delay at x: peelSpan * x / aspect from the left, or peelSpan * (1 - x / aspect).
    const left = w.peelDir > 0;
    out[o] = left ? tau : tau - w.peelSpan;
    out[o + 1] = ((left ? 1 : -1) * w.peelSpan) / a;
    out[o + 2] = w.reach;
    out[o + 3] = 0;
    out[o + 4] = w.offX;
    out[o + 5] = w.offY;
    out[o + 6] = 0;
    out[o + 7] = 0;
  }
  return n;
}

/**
 * Shoreline (still-water line) for a layout at `aspect`: y = out[0] + out[1] * x,
 * in height units. "Low" runs level across the lower third; the diagonals rise
 * toward the named side, leaving more sand there. Unknown values fall back to low.
 */
export function shoreLine(layout: string, aspect: number, out: Float32Array): Float32Array {
  const a = Math.max(aspect, 1e-3);
  if (layout === "diagonal-left") {
    out[0] = 0.4;
    out[1] = -0.28 / a;
  } else if (layout === "diagonal-right") {
    out[0] = 0.12;
    out[1] = 0.28 / a;
  } else {
    out[0] = HORIZON - CAMERA_K;
    out[1] = 0;
  }
  return out;
}

/**
 * Shore normal n at screen point (x, y) (height units, y up, below the horizon)
 * for a shoreline y = c + k x. The shader mirrors this.
 */
export function shoreNormal(x: number, y: number, c: number, k: number): number {
  const ys = c + k * x;
  return CAMERA_K / (HORIZON - ys) - CAMERA_K / (HORIZON - y);
}
