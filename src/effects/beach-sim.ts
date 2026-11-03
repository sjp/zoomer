/**
 * Pure model for the "Beach from above" effect: shore-aligned layout, the wave
 * run-up timeline, the wet band it leaves, the wave scheduler and the uniform
 * packing. Coordinates are frame-height units: `s` along the shore, `n` across it,
 * positive landward, with the (noisy) shoreline at n = 0.
 */
import { createNoise, createRng } from "./noise";
import { clamp, smoothstep } from "./math";
import { MIN_WAVE_TIME, MAX_WAVE_TIME } from "./beach.meta";
import {
  T_ACTIVE,
  T_APPROACH,
  T_DRY,
  T_RUNUP,
  T_STOP,
  washFront,
  washSinceUncovered,
} from "./wash";

export { T_ACTIVE, T_APPROACH, T_DRAIN, T_DRY, T_RUNUP, T_STOP } from "./wash";

/** Seconds a wave stays in flight after draining, while its wet band dries. */
export const WET_TAIL = 10;
/** A wave's whole life; it is retired after this. */
export const LIFETIME = T_ACTIVE + WET_TAIL;
/** The last seconds of its life over which a wave's wet band fades to nothing. */
export const WET_FADE = 3;
/** Distance seaward of the shoreline (height units) where waves break. */
export const BREAK = 0.06;
/** Distance seaward where a swell line starts its approach. */
export const APPROACH_DIST = 0.7;

/** Fixed number of wave slots. LIFETIME / (MIN_WAVE_TIME * SPACING_MIN) must not exceed it. */
export const MAX_WAVES = 4;
/** Each spacing is waveTime times a factor in [SPACING_MIN, SPACING_MAX). */
export const SPACING_MIN = 0.85;
export const SPACING_MAX = 1.15;
/** Each wave's reach is the reach param times a factor in [REACH_MIN, REACH_MAX). */
export const REACH_MIN = 0.75;
export const REACH_MAX = 1.2;

/** Along-shore wiggle of a front: SHAPE_BASE plus SHAPE_GAIN times its run-up so far. */
export const SHAPE_BASE = 0.012;
export const SHAPE_GAIN = 0.3;

/** Floats per wave in the packed uniform array (four vec4s). */
export const WAVE_FLOATS = 16;

/**
 * Position of a wave's front (n, height units) `tau` seconds after it starts, for a
 * run-up of `reach`: approaching at constant speed, then breaking at -BREAK and
 * running up with constant deceleration to `reach`, stopping, and draining back
 * with constant acceleration to the shoreline, where it stays. Continuous, bounded
 * by [-APPROACH_DIST, reach], and 0 from T_ACTIVE on.
 */
export function waveFront(tau: number, reach: number): number {
  return washFront(tau, reach, BREAK, APPROACH_DIST);
}

/** Highest the front has reached by `tau`: the front itself until it stops, then `reach`. */
export function maxReach(tau: number, reach: number): number {
  return tau < T_STOP ? waveFront(tau, reach) : reach;
}

/** Fade of a wave's wet band over the end of its life: 1, then down to 0 at LIFETIME. */
export function wetFade(tau: number): number {
  return 1 - smoothstep(LIFETIME - WET_FADE, LIFETIME, tau);
}

/**
 * Wetness (0..1) a wave leaves at `n`, `tau` seconds after it starts (with no
 * along-shore wiggle; the shader adds it). Sand the run-up covered stays fully wet
 * until the draining sheet uncovers it, then dries exponentially with T_DRY. The
 * shader mirrors this.
 */
export function waveWetness(n: number, tau: number, reach: number): number {
  const m = maxReach(tau, reach);
  if (m <= 0 || n > m) return 0;
  const since = washSinceUncovered(n, tau, m);
  return Math.exp(-Math.max(0, since) / T_DRY) * wetFade(tau);
}

/** Strength of a wave's main foam band: a whitening crest, the break, then thinning. */
export function foamStrength(tau: number): number {
  if (tau < T_APPROACH) return 0.35 * smoothstep(T_APPROACH - 0.8, T_APPROACH, tau);
  if (tau < T_STOP) {
    const u = (tau - T_APPROACH) / T_RUNUP;
    return 0.35 + 0.65 * smoothstep(0, 0.12, u) - 0.35 * u;
  }
  return 0.65 * (1 - smoothstep(T_STOP, T_ACTIVE + 1.5, tau));
}

/** Width (height units) of the foam band trailing the front: it spreads as it ages. */
export function foamWidth(tau: number): number {
  return 0.012 + 0.05 * smoothstep(T_APPROACH, T_ACTIVE, tau);
}

/** Strength of the lingering foam patches left in the surf zone after the break. */
export function residualFoam(tau: number): number {
  return (
    0.55 *
    smoothstep(T_APPROACH, T_APPROACH + 0.8, tau) *
    (1 - smoothstep(T_STOP, T_ACTIVE + 4, tau))
  );
}

/** Strength of the thin line of foam left at the top of the run-up as the sheet drains. */
export function swashMark(tau: number): number {
  return 0.7 * smoothstep(T_STOP - 0.4, T_STOP, tau) * (1 - smoothstep(T_STOP, T_STOP + 2.5, tau));
}

/** Strength of a swell line's light ridge: fades in, then gives way to foam at the break. */
export function swellStrength(tau: number): number {
  return smoothstep(0, 1.5, tau) * (1 - smoothstep(T_APPROACH - 0.3, T_APPROACH + 0.3, tau));
}

/** Strength of the thin water sheet over the sand: full while running up, fading as it drains. */
export function sheetStrength(tau: number): number {
  return 1 - 0.6 * smoothstep(T_STOP, T_ACTIVE, tau);
}

export interface Wave {
  /** Start time on the scheduler clock (s). */
  start: number;
  reach: number;
  /** Weights mixing the four 1D shape-table channels into this front's wiggle. */
  readonly weights: Float64Array;
  /** Offsets into the foam noise texture, so fronts don't share a pattern. */
  offX: number;
  offY: number;
}

export interface WaveScheduler {
  /** Live waves, oldest first; only the first `count` are in flight. */
  readonly waves: readonly Wave[];
  readonly count: number;
  /** Scheduler clock (s), unwrapped float64. */
  readonly time: number;
  /** Advances the clock, retires finished waves and starts a new one when due. */
  step(dt: number, waveTime: number, reach: number): void;
}

export function createWaveScheduler(seed: number): WaveScheduler {
  const rng = createRng(seed);
  const waves: Wave[] = [];
  for (let i = 0; i < MAX_WAVES; i++) {
    waves.push({ start: 0, reach: 0, weights: new Float64Array(4), offX: 0, offY: 0 });
  }
  let count = 0;
  let time = 0;
  /** When the next wave is due; the first one starts straight away. */
  let nextAt = 0;

  const spawn = (waveTime: number, reach: number) => {
    const w = waves[count++];
    w.start = time;
    w.reach = reach * (REACH_MIN + (REACH_MAX - REACH_MIN) * rng());
    let len = 0;
    for (let k = 0; k < 4; k++) {
      const v = rng() * 2 - 1;
      w.weights[k] = v;
      len += v * v;
    }
    // Unit length, so every front wiggles about as much as one channel does.
    const inv = len > 1e-6 ? 1 / Math.sqrt(len) : 1;
    for (let k = 0; k < 4; k++) w.weights[k] = len > 1e-6 ? w.weights[k] * inv : k === 0 ? 1 : 0;
    w.offX = rng();
    w.offY = rng();
    nextAt = time + waveTime * (SPACING_MIN + (SPACING_MAX - SPACING_MIN) * rng());
  };

  return {
    waves,
    get count() {
      return count;
    },
    get time() {
      return time;
    },
    step(dt, waveTime, reach) {
      time += Math.max(0, dt);
      // Waves share one lifetime, so they retire in start order from the front.
      while (count > 0 && time - waves[0].start >= LIFETIME) {
        const done = waves[0];
        for (let i = 1; i < count; i++) waves[i - 1] = waves[i];
        waves[count - 1] = done;
        count--;
      }
      // When every slot is busy, the next wave waits for one to free up.
      if (time >= nextAt && count < MAX_WAVES) {
        spawn(clamp(waveTime, MIN_WAVE_TIME, MAX_WAVE_TIME), reach);
      }
    },
  };
}

/**
 * Packs the live waves into `out` (WAVE_FLOATS per wave) for the shader:
 *
 * - A: front n, wiggle amplitude, max reach, seconds since the run-up stopped.
 * - B: foam band strength (times `foam`), 1 / band width, residual foam, swash mark.
 * - C: swell strength, sheet strength, wet fade, unused.
 * - D: shape-table weights.
 *
 * Returns the number of waves packed. Foam offsets go in `offsets` (vec2 per wave).
 */
export function packWaves(
  sched: WaveScheduler,
  foam: number,
  out: Float32Array,
  offsets: Float32Array,
): number {
  const n = sched.count;
  for (let i = 0; i < n; i++) {
    const w = sched.waves[i];
    const tau = sched.time - w.start;
    const m = maxReach(tau, w.reach);
    const o = i * WAVE_FLOATS;
    out[o] = waveFront(tau, w.reach);
    out[o + 1] = SHAPE_BASE + SHAPE_GAIN * Math.max(0, m);
    out[o + 2] = m;
    out[o + 3] = tau - T_STOP;
    out[o + 4] = foamStrength(tau) * foam;
    out[o + 5] = 1 / foamWidth(tau);
    out[o + 6] = residualFoam(tau) * foam;
    out[o + 7] = swashMark(tau) * foam;
    out[o + 8] = swellStrength(tau);
    out[o + 9] = sheetStrength(tau);
    out[o + 10] = wetFade(tau);
    out[o + 11] = 0;
    out[o + 12] = w.weights[0];
    out[o + 13] = w.weights[1];
    out[o + 14] = w.weights[2];
    out[o + 15] = w.weights[3];
    offsets[i * 2] = w.offX;
    offsets[i * 2 + 1] = w.offY;
  }
  return n;
}

export type BeachLayout = "left" | "right" | "bottom" | "diagonal";

/**
 * Shore axes for a layout at `aspect` (width / height): n = dot(p, (x, y)) - c and
 * s = dot(p, (-y, x)), with p in height units (origin bottom-left, y up). Writes
 * (x, y, c) into `out`. The sea fills a strip along one side (or the bottom-left
 * corner), so the speaker in the middle sits over calm sand.
 */
export function layoutAxes(layout: string, aspect: number, out: Float32Array): Float32Array {
  let x: number;
  let y: number;
  let c: number;
  if (layout === "left") {
    [x, y, c] = [1, 0, 0.2 * aspect];
  } else if (layout === "right") {
    [x, y, c] = [-1, 0, -0.8 * aspect];
  } else if (layout === "bottom") {
    [x, y, c] = [0, 1, 0.24];
  } else {
    // A line from (0.45 aspect, 0) on the bottom edge to (0, 0.62) on the left edge.
    const ax = 0.45 * aspect;
    const ay = 0.62;
    const len = Math.hypot(ax, ay);
    x = ay / len;
    y = ax / len;
    c = (ax * ay) / len;
  }
  out[0] = x;
  out[1] = y;
  out[2] = c;
  return out;
}

/** Columns of the 1D shape table along the shore. */
export const SHAPE_COLUMNS = 256;
/** Lattice cells of 1D noise across the table. */
const SHAPE_PERIOD = 8;
/** The table repeats every SHAPE_SPAN height units along the shore. */
export const SHAPE_SPAN = 4;

/**
 * Four channels of smooth, periodic 1D noise along the shore (RGBA, roughly -0.7..0.7),
 * mixed per wave into the front wiggle and, with fixed weights, the shoreline.
 */
export function buildShapeTable(seed: number): Float32Array {
  const data = new Float32Array(SHAPE_COLUMNS * 4);
  for (let c = 0; c < 4; c++) {
    const noise = createNoise(seed + c * 101);
    for (let i = 0; i < SHAPE_COLUMNS; i++) {
      const x = (i / SHAPE_COLUMNS) * SHAPE_PERIOD;
      // Two octaves; the second's period is twice the first's lattice count.
      const v =
        noise.periodic2(x, 0.5, SHAPE_PERIOD, SHAPE_PERIOD) * 0.7 +
        noise.periodic2(x * 2 + 9.1, 3.3, SHAPE_PERIOD * 2, SHAPE_PERIOD * 2) * 0.3;
      data[i * 4 + c] = v;
    }
  }
  return data;
}

/** Fixed weights of the shape channels for the shoreline itself. */
export const SHORE_WEIGHTS: readonly [number, number, number, number] = [0.8, -0.4, 0.3, 0.33];

export interface WaterPalette {
  deep: string;
  mid: string;
  /** Tint of the seabed seen through shallow water, and of the swash sheet. */
  shallow: string;
  foam: string;
}

const TROPICAL: WaterPalette = {
  deep: "#0a4f8c",
  mid: "#17b3c2",
  shallow: "#c4fff0",
  foam: "#f6fbfb",
};
const ATLANTIC: WaterPalette = {
  deep: "#10394a",
  mid: "#2c7781",
  shallow: "#b3dcd2",
  foam: "#eef3f2",
};
const DUSK: WaterPalette = {
  deep: "#1c2250",
  mid: "#476b98",
  shallow: "#f2c7b8",
  foam: "#fbe7dc",
};

/** Palette for a `water` select value; unknown values fall back to Tropical. */
export function waterPalette(water: string): WaterPalette {
  if (water === "atlantic") return ATLANTIC;
  if (water === "dusk") return DUSK;
  return TROPICAL;
}
