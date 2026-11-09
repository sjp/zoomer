/**
 * Pure JS logic for the day-night horizon (horizon.ts): the day-phase clock, the
 * sky keyframe table, the sun and moon arcs, the lunar phase, and the hill
 * profiles. Nothing here touches GL, so it is all unit tested.
 */
import { hexToUnitRgb, type Rgb } from "../color";
import { clamp, fract, smoothstep } from "../math";
import { createRng } from "../noise";
import { MIN_LAYERS, MAX_LAYERS } from "./horizon.meta";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Day phase
// ---------------------------------------------------------------------------

export type TimeMode = "local" | "cycle" | "fixed";

/** Seconds between reads of the wall clock in local-clock mode. */
export const CLOCK_READ_INTERVAL = 1;
const SECONDS_PER_DAY = 86400;

/** Local time of day of `d` as a phase in [0, 1): 0 is midnight, 0.5 noon. */
export function localDayPhase(d: Date): number {
  const s = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
  return fract(s / SECONDS_PER_DAY);
}

interface DayClock {
  /** The current day phase in [0, 1). */
  readonly phase: number;
  /**
   * Advances by `dt` seconds in `mode` and returns the new phase. Switching into
   * cycle mode continues from the current phase rather than jumping.
   */
  step: (dt: number, mode: TimeMode, cycleMins: number, hour: number) => number;
}

/**
 * The day-phase clock. `readClock` returns the local day phase (see
 * `localDayPhase`); it is called about once a second in local-clock mode, and the
 * phase advances with `dt` in between, so the sun moves smoothly without a `Date`
 * per frame. Cycle mode keeps its time unwrapped, in days, in float64, and hands
 * out only the wrapped phase.
 */
export function createDayClock(
  readClock: () => number = () => localDayPhase(new Date()),
  initialPhase = 0.5,
): DayClock {
  let phase = fract(initialPhase);
  /** Cycle mode's elapsed days, unwrapped. */
  let days = phase;
  let lastMode: TimeMode | undefined;
  /** Seconds since the wall clock was last read. */
  let sinceRead = 0;
  return {
    get phase() {
      return phase;
    },
    step(dt, mode, cycleMins, hour) {
      if (mode === "local") {
        sinceRead += dt;
        if (lastMode !== "local" || sinceRead >= CLOCK_READ_INTERVAL) {
          sinceRead = 0;
          phase = fract(readClock());
        } else {
          phase = fract(phase + dt / SECONDS_PER_DAY);
        }
      } else if (mode === "cycle") {
        if (lastMode !== "cycle") {
          days = phase;
        }
        days += dt / (Math.max(cycleMins, 0.01) * 60);
        phase = fract(days);
      } else {
        phase = fract(hour / 24);
      }
      lastMode = mode;
      return phase;
    },
  };
}

// ---------------------------------------------------------------------------
// Sky keyframes
// ---------------------------------------------------------------------------

/** One sky keyframe: the hour it applies at, its colours and the sun glow strength. */
export interface SkyKey {
  hour: number;
  zenith: Rgb;
  horizon: Rgb;
  /** Colour the sun glow warms the sky towards. */
  glow: Rgb;
  /** Light falling on the hills (multiplies their daylight colour). */
  light: Rgb;
  /** Strength of the sun glow, 0..1. */
  glowStrength: number;
}

const key = (
  hour: number,
  zenith: string,
  horizon: string,
  glow: string,
  light: string,
  glowStrength: number,
): SkyKey => ({
  hour,
  zenith: hexToUnitRgb(zenith),
  horizon: hexToUnitRgb(horizon),
  glow: hexToUnitRgb(glow),
  light: hexToUnitRgb(light),
  glowStrength,
});

/** The day's sky, in increasing hour order. Interpolation wraps from the last to the first. */
export const SKY_KEYS: readonly SkyKey[] = [
  key(1, "#03071a", "#0b1636", "#1b2550", "#161d33", 0),
  key(4.6, "#03071a", "#0b1636", "#1b2550", "#161d33", 0),
  key(5.4, "#111640", "#443766", "#8a5786", "#3a3550", 0.25),
  key(6.1, "#2a4482", "#f0977a", "#ffa866", "#9a7f7a", 0.85),
  key(7.2, "#3d78c8", "#c6d9e8", "#ffe9bf", "#d9d6cc", 0.55),
  key(12, "#2d6ad2", "#a7d0f0", "#fffbe8", "#ffffff", 0.4),
  key(16.4, "#3772c6", "#c3daea", "#fff0c4", "#f4efe2", 0.45),
  key(17.5, "#4766a6", "#ffc074", "#ffd27c", "#e6c49a", 0.8),
  key(18.15, "#383c80", "#ff6e42", "#ff9640", "#8c6460", 1),
  key(18.8, "#211f4c", "#874677", "#c0586a", "#47394f", 0.45),
  key(19.8, "#03071a", "#0b1636", "#1b2550", "#161d33", 0),
];

export interface SkyState {
  zenith: Rgb;
  horizon: Rgb;
  glow: Rgb;
  light: Rgb;
  glowStrength: number;
}

export const createSkyState = (): SkyState => ({
  zenith: [0, 0, 0],
  horizon: [0, 0, 0],
  glow: [0, 0, 0],
  light: [0, 0, 0],
  glowStrength: 0,
});

const lerpInto = (out: Rgb, a: Rgb, b: Rgb, t: number) => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
};

/**
 * Interpolates the keyframes at day `phase` (any number; wrapped to [0, 1)) into
 * `out`, easing between neighbouring keys with a smoothstep so the colours glide
 * through each key rather than turning sharply. Continuous across midnight.
 * Allocates nothing.
 */
export function sampleSky(phase: number, out: SkyState, keys: readonly SkyKey[] = SKY_KEYS): void {
  const h = fract(phase) * 24;
  const n = keys.length;
  // The segment [keys[i], keys[i + 1]] holding h, wrapping past midnight.
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    if (keys[k].hour <= h) {
      i = k;
    } else {
      break;
    }
  }
  const a = keys[i];
  const b = keys[(i + 1) % n];
  let span = b.hour - a.hour;
  let into = h - a.hour;
  if (span <= 0) {
    span += 24;
  }
  if (into < 0) {
    into += 24;
  }
  const t = smoothstep(0, 1, into / span);
  lerpInto(out.zenith, a.zenith, b.zenith, t);
  lerpInto(out.horizon, a.horizon, b.horizon, t);
  lerpInto(out.glow, a.glow, b.glow, t);
  lerpInto(out.light, a.light, b.light, t);
  out.glowStrength = a.glowStrength + (b.glowStrength - a.glowStrength) * t;
}

// ---------------------------------------------------------------------------
// Sun and moon
// ---------------------------------------------------------------------------

/** Horizontal half-span of the sun and moon arcs, as a fraction of the width. */
const ARC_HALF_WIDTH = 0.44;

interface ArcPoint {
  /** Fraction of the width, 0 left. */
  x: number;
  /** Elevation, -1..1: sin of the angle above the horizon; the arc's height is `ARC_HEIGHT`. */
  elevation: number;
}

/**
 * Sun position at day `phase`: it rises at the left at 06:00, peaks at the top
 * centre at noon and sets at the right at 18:00, travelling under the horizon
 * at night. The moon (`moon = true`) runs the opposite half of the same circle,
 * rising at the left at 18:00 and peaking at midnight.
 */
export function arcPosition(phase: number, moon: boolean, out: ArcPoint): ArcPoint {
  const theta = TAU * (fract(phase) - 0.25) + (moon ? Math.PI : 0);
  out.x = 0.5 - ARC_HALF_WIDTH * Math.cos(theta);
  out.elevation = Math.sin(theta);
  return out;
}

/** How dark the night is, 0 by day to 1 once the sun is well below the horizon. */
export const nightAmount = (sunElevation: number) => smoothstep(0.05, 0.35, -sunElevation);

/** A new moon (2000-01-06 18:14 UTC) and the mean synodic month. */
const NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);
const SYNODIC_MS = 29.530588853 * SECONDS_PER_DAY * 1000;

/** Moon phase at `ms` (Unix ms): 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
export const lunarPhase = (ms: number) => fract((ms - NEW_MOON_MS) / SYNODIC_MS);

/**
 * Terminator parameters for the moon shader: a point (x, y) on the unit disc is
 * lit when `x * side > k * sqrt(1 - y^2)`. Waxing moons are lit on the right
 * (northern-hemisphere view). Also returns the lit fraction of the disc, for the
 * halo's strength.
 */
interface Terminator {
  k: number;
  side: number;
  lit: number;
}

export function moonTerminator(phase: number, out: Terminator): Terminator {
  const p = fract(phase);
  out.k = Math.cos(TAU * p);
  out.side = p < 0.5 ? 1 : -1;
  out.lit = (1 - out.k) / 2;
  return out;
}

// ---------------------------------------------------------------------------
// Hills
// ---------------------------------------------------------------------------

/** Profile samples across the width, per layer. */
export const HILL_COLUMNS = 257;
/** Baseline height (fraction of the canvas height from the bottom) of the back and front layers. */
export const BACK_BASE = 0.4;
export const FRONT_BASE = 0.13;
/** Amplitude of the back and front layers, before the palette's multiplier. */
const BACK_AMP = 0.045;
const FRONT_AMP = 0.065;
const OCTAVES = 4;

/** How a palette's hills are shaped. */
export interface HillShape {
  /** Amplitude multiplier. */
  amp: number;
  /** 0 rolling sines to 1 sharp ridged peaks. */
  ridge: number;
  /** Frequency multiplier. */
  freq: number;
}

/** Layer `i` of `n` from the back (0) to the front (n - 1), as 0..1. */
export const layerDepth = (i: number, n: number) => (n > 1 ? i / (n - 1) : 1);

/**
 * Fills `out` (`MAX_LAYERS * HILL_COLUMNS` floats, row = layer, back first) with
 * `layers` hill profiles for `seed`: heights as fractions of the canvas height
 * above its bottom, sampled at x = column / (HILL_COLUMNS - 1) of the width. Each
 * layer is a few summed sines (ridged by `shape.ridge`); nearer layers sit lower
 * and roll larger. Writes each layer's lowest and highest point into `min` and
 * `max`. Deterministic for a seed; unused rows are zeroed.
 */
export function buildHills(
  out: Float32Array,
  layers: number,
  seed: number,
  shape: HillShape,
  min: Float64Array,
  max: Float64Array,
): void {
  out.fill(0);
  min.fill(0);
  max.fill(0);
  const n = clamp(Math.round(layers), MIN_LAYERS, MAX_LAYERS);
  const freq = new Float64Array(OCTAVES);
  const phase = new Float64Array(OCTAVES);
  for (let l = 0; l < n; l++) {
    const rand = createRng(Math.floor(seed) * 31 + l * 7919 + 1);
    const depth = layerDepth(l, n);
    const base = BACK_BASE + (FRONT_BASE - BACK_BASE) * depth;
    const amp = (BACK_AMP + (FRONT_AMP - BACK_AMP) * depth) * shape.amp;
    // Nearer layers are seen closer up, so their features are broader on screen.
    const f0 = (1.2 + rand() * 0.8) * shape.freq * (1.25 - 0.45 * depth);
    let norm = 0;
    for (let o = 0; o < OCTAVES; o++) {
      freq[o] = f0 * 2 ** o * (0.85 + rand() * 0.3);
      phase[o] = rand() * TAU;
      norm += 0.5 ** o;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let c = 0; c < HILL_COLUMNS; c++) {
      const x = c / (HILL_COLUMNS - 1);
      let v = 0;
      for (let o = 0; o < OCTAVES; o++) {
        const s = Math.sin(TAU * freq[o] * x + phase[o]);
        v += (s + (1 - 2 * Math.abs(s) - s) * shape.ridge) * 0.5 ** o;
      }
      const h = base + amp * (v / norm);
      out[l * HILL_COLUMNS + c] = h;
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    min[l] = lo;
    max[l] = hi;
  }
}

/** Height of profile row `layer` at x (0..1 of the width), linearly interpolated like the mesh. */
export function hillHeightAt(profiles: Float32Array, layer: number, x: number): number {
  const t = clamp(x, 0, 1) * (HILL_COLUMNS - 1);
  const i = Math.min(Math.floor(t), HILL_COLUMNS - 2);
  const o = layer * HILL_COLUMNS + i;
  return profiles[o] + (profiles[o + 1] - profiles[o]) * (t - i);
}

/** Floats per tree instance: x (fraction of width), base y (fraction of height), height, half-width (px at 1080). */
export const TREE_FLOATS = 4;

/**
 * Lays up to `maxTrees` conifer silhouettes along front profile row `layer`,
 * deterministic for `seed`, thinned out in the middle of the frame where the
 * speaker sits. Writes `TREE_FLOATS` floats per tree into `out` and returns the count.
 */
export function placeTrees(
  out: Float32Array,
  maxTrees: number,
  profiles: Float32Array,
  layer: number,
  seed: number,
): number {
  const rand = createRng(Math.floor(seed) * 131 + 977);
  let n = 0;
  for (let k = 0; k < maxTrees * 3 && n < maxTrees; k++) {
    // Scattered unevenly: a share of candidates is dropped, most of them in the middle.
    const x = rand();
    const r = rand();
    if (Math.abs(x - 0.5) < 0.2 && r < 0.85) {
      continue;
    }
    if (r > 0.75) {
      continue;
    }
    const height = 14 + rand() * 22;
    const o = n * TREE_FLOATS;
    out[o] = x;
    out[o + 1] = hillHeightAt(profiles, layer, x);
    out[o + 2] = height;
    out[o + 3] = height * (0.26 + rand() * 0.08);
    n++;
  }
  return n;
}
