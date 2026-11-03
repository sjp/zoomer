/**
 * CPU side of the autumn-lake effect: the treeline column table, the season
 * palettes, the water-plane projection, the ripple-ring scheduler (the drop
 * buffer and Poisson spawner of `ripples-sim.ts`, a few rings at a time) and the
 * wind-patch mask. No GL here, so it is unit tested directly.
 *
 * Screen space is in frame-height units: `y` runs 0..1 from the bottom of the
 * frame, `x = (u - 0.5) · aspect` from its centre. The far bank sits on the
 * shoreline `y = shore`. The water is a horizontal plane seen by a camera one
 * unit above it with a focal length of one frame height: a water point at depth
 * `Z` appears `1 / Z` below the (hidden) horizon, which lies `HORIZON_GAP` above
 * the shoreline. So `Z = 1 / (shore + HORIZON_GAP - y)` and `X = x · Z`; rings
 * are circles in (X, Z), which perspective squashes into ellipses on screen.
 */

import { hexToUnitRgb } from "./color";
import type { Season } from "./lake.meta";
import { approach, clamp, smoothstep } from "./math";
import { createRng } from "./noise";
import {
  createRainState,
  PACKET_HALF,
  type RainState,
  ringAmplitude,
  stepRain,
} from "./ripples-sim";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Water plane

/** Height of the hidden horizon above the shoreline, in frame heights. */
export const HORIZON_GAP = 0.06;

/**
 * Water-plane coordinates of the screen point (`u` across the frame 0..1, `y` up
 * the frame 0..1) below the shoreline, written to `out` as `[X, Z]`.
 */
export function toPlane(
  u: number,
  y: number,
  shore: number,
  aspect: number,
  out: [number, number] | Float64Array,
): void {
  const z = 1 / Math.max(HORIZON_GAP, shore + HORIZON_GAP - y);
  out[0] = (u - 0.5) * aspect * z;
  out[1] = z;
}

// ---------------------------------------------------------------------------
// Treeline

/** Columns of the treeline table across the frame width. */
export const TREE_COLUMNS = 1024;
/** Per column: front crown top, colour key, crown roundness, back crown top. */
export const TREE_CHANNELS = 4;
/** Colour key of an evergreen; deciduous keys run 0..1 along the season ramp. */
export const EVERGREEN_KEY = 2;
/** Low undergrowth along the whole bank, in frame heights. */
export const MIN_FRONT = 0.014;
/** The hazy back row never drops below this. */
export const MIN_BACK = 0.03;
/** Highest any crown reaches above the shoreline, in frame heights. */
export const MAX_TREE = 0.2;
/** Share of front crowns that are evergreens. */
const EVERGREEN_SHARE = 0.2;
/** Crowns start this far outside the frame, so the edges are covered too. */
const MARGIN = 0.1;

/** Writes one crown into the columns it covers wherever it is the tallest so far. */
function paintCrown(
  out: Float32Array,
  aspect: number,
  cx: number,
  halfW: number,
  base: number,
  rise: number,
  key: number,
  cone: boolean,
  back: boolean,
): void {
  const n = TREE_COLUMNS;
  const i0 = Math.max(0, Math.floor(((cx - halfW) / aspect) * n));
  const i1 = Math.min(n - 1, Math.ceil(((cx + halfW) / aspect) * n));
  for (let i = i0; i <= i1; i++) {
    const x = ((i + 0.5) / n) * aspect;
    const q = Math.abs(x - cx) / halfW;
    if (q >= 1) continue;
    const round = cone ? 1 - q : Math.sqrt(1 - q * q);
    const top = Math.min(MAX_TREE, base + rise * round);
    const o = i * TREE_CHANNELS;
    if (back) {
      if (top > out[o + 3]) out[o + 3] = top;
    } else if (top > out[o]) {
      out[o] = top;
      out[o + 1] = key;
      out[o + 2] = round;
    }
  }
}

/**
 * Fills the treeline table (`TREE_COLUMNS × TREE_CHANNELS` floats) for a frame of
 * `aspect` (width / height) from overlapping seeded crowns: a hazy back row of
 * broad rounded crowns, and a front row of rounded deciduous crowns mixed with
 * pointed evergreens. Per column: the front top above the shoreline (frame
 * heights), the winning crown's colour key (0..1, or `EVERGREEN_KEY`), how far
 * in from the crown's edge the column is (0..1, for shading) and the back top.
 * Deterministic per seed and aspect.
 */
export function fillTreeTable(out: Float32Array, seed: number, aspect: number): void {
  const a = Number.isFinite(aspect) && aspect > 0.1 ? aspect : 16 / 9;
  for (let i = 0; i < TREE_COLUMNS; i++) {
    const o = i * TREE_CHANNELS;
    out[o] = MIN_FRONT;
    out[o + 1] = 0.3;
    out[o + 2] = 0.2;
    out[o + 3] = MIN_BACK;
  }
  const rng = createRng(Math.floor(seed) * 7919 + 72);
  const u = (lo: number, hi: number) => lo + (hi - lo) * rng();

  for (let x = -MARGIN; x < a + MARGIN;) {
    const r = u(0.045, 0.08);
    paintCrown(out, a, x, r, u(0.06, 0.11), r * u(0.6, 0.85), 0, false, true);
    x += r * u(0.7, 1.2);
  }
  for (let x = -MARGIN; x < a + MARGIN;) {
    if (rng() < EVERGREEN_SHARE) {
      const w = u(0.014, 0.024);
      paintCrown(out, a, x, w, 0, u(0.09, 0.15), EVERGREEN_KEY, true, false);
      x += w * u(1, 2);
    } else {
      const r = u(0.022, 0.045);
      paintCrown(out, a, x, r, u(0.035, 0.075), r * u(0.75, 1), rng(), false, false);
      x += r * u(0.6, 1.1);
    }
  }
}

// ---------------------------------------------------------------------------
// Palettes

/** vec3 entries in a palette, in this order. */
export const PAL_RAMP = 0; // four entries: the deciduous ramp, key 0 → 1
export const PAL_EVERGREEN = 4;
export const PAL_BACK = 5;
export const PAL_SKY_LOW = 6;
export const PAL_SKY_HIGH = 7;
export const PAL_WATER = 8;
export const PAL_MIST = 9;
export const PALETTE_ENTRIES = 10;
export const PALETTE_FLOATS = PALETTE_ENTRIES * 3;

const PALETTE_HEX: Readonly<Record<Season, readonly string[]>> = {
  summer: [
    "#2f5a2a",
    "#3f7434",
    "#5a8a3c",
    "#7d9a45",
    "#1f3a2a",
    "#82978f",
    "#dfe7ea",
    "#a9c2d6",
    "#1b2829",
    "#e8eef0",
  ],
  early: [
    "#4b6e2f",
    "#8a8a34",
    "#c99a2e",
    "#d0702a",
    "#22392b",
    "#9a9d88",
    "#e9e6dc",
    "#b5c6d3",
    "#222924",
    "#efece4",
  ],
  peak: [
    "#8e2219",
    "#c2421c",
    "#e07a22",
    "#e8b33a",
    "#1e3428",
    "#a99a8c",
    "#efe6da",
    "#bccbd6",
    "#28231f",
    "#f2ece4",
  ],
  late: [
    "#5a3a26",
    "#8a4e24",
    "#a8742e",
    "#7d6a58",
    "#1d3027",
    "#9d9890",
    "#dcdcd8",
    "#aab4bd",
    "#212429",
    "#e6e6e4",
  ],
};

const toPalette = (hex: readonly string[]) => {
  const out = new Float32Array(PALETTE_FLOATS);
  hex.forEach((h, i) => out.set(hexToUnitRgb(h), i * 3));
  return out;
};

/** Each season's palette as `PALETTE_FLOATS` unit RGB floats. */
export const SEASON_PALETTES: Readonly<Record<Season, Float32Array>> = {
  summer: toPalette(PALETTE_HEX.summer),
  early: toPalette(PALETTE_HEX.early),
  peak: toPalette(PALETTE_HEX.peak),
  late: toPalette(PALETTE_HEX.late),
};

/** The palette for a season select value; unknown values fall back to "peak". */
export function seasonPalette(season: string): Float32Array {
  return season === "summer" || season === "early" || season === "late"
    ? SEASON_PALETTES[season]
    : SEASON_PALETTES.peak;
}

/** Palette fade speed: a full change of one channel takes about 1.5 s. */
export const PALETTE_RATE = 0.7;

/**
 * Moves `cur` towards `target` by at most `step` per channel, so a season change
 * fades instead of snapping. Returns whether anything changed.
 */
export function blendPalette(cur: Float32Array, target: Float32Array, step: number): boolean {
  let changed = false;
  for (let i = 0; i < cur.length; i++) {
    const v = approach(cur[i], target[i], step);
    if (v !== cur[i]) {
      cur[i] = v;
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Ripple rings

/** Most rings alive at once; the oldest is recycled beyond this. */
export const MAX_RINGS = 6;
/** Floats per ring in the packed uniform array: two vec4s (see `packRings`). */
export const RING_STRIDE = 8;
/** Seconds a ring lives. */
export const RING_LIFE = 7;
/** Ring speed on the water plane, in camera heights per second. */
export const RING_SPEED = 0.05;
/** Wavelength at birth on the water plane, in camera heights. */
export const RING_WAVELENGTH = 0.05;
/** Relative wavelength growth per second of age. */
export const RING_SPREAD = 0.2;
/** Peak slope of a fresh ring at full strength. */
export const RING_AMP = 0.3;
/** Rings spawn no further out than this, where they would shrink below a few pixels. */
export const RING_Z_FAR = 4;
/** Rings spawn this much beyond the nearest visible water. */
const RING_Z_NEAR = 1.08;
/** Rings spawn this far in from the frame's sides (fraction of the width). */
const RING_U_EDGE = 0.05;

export type RingState = RainState;

export function createRingState(rng: () => number): RingState {
  return createRainState(rng, MAX_RINGS);
}

/**
 * Advances the rings by `dt` seconds with Poisson arrivals at `perMinute`. Each
 * ring is stored with a position in [0, 1]² that `packRings` maps onto the
 * visible water. Allocates nothing.
 */
export function stepRings(s: RingState, dt: number, perMinute: number, rng: () => number): void {
  const rate = Number.isFinite(perMinute) ? Math.max(0, perMinute) / 60 : 0;
  stepRain(s, dt, rate, 0, RING_SPEED, rng);
}

/** Depth range rings spawn over for this shoreline: near the viewer out to `RING_Z_FAR`. */
export function ringDepthRange(shore: number, out: [number, number]): [number, number] {
  const near = RING_Z_NEAR / (shore + HORIZON_GAP);
  out[0] = near;
  out[1] = Math.max(near, RING_Z_FAR);
  return out;
}

const range: [number, number] = [0, 0];

/**
 * Packs the live rings into `out` as two vec4s each, in water-plane units, and
 * returns how many were written (never more than fit in `out`):
 *
 * - `vec4(X, Z, rOut², 1 / (W k))`: centre, outer radius squared and the
 *   envelope term of the slope;
 * - `vec4(ρ, 1 / W, k, A)`: packet radius, inverse half-width, wavenumber and
 *   amplitude.
 *
 * The same packet as `ripples-sim.ts`, so the shader's slope sum is its twin.
 */
export function packRings(out: Float32Array, s: RingState, shore: number, aspect: number): number {
  const b = s.drops;
  const max = Math.min(b.count, Math.floor(out.length / RING_STRIDE));
  ringDepthRange(shore, range);
  let n = 0;
  for (let i = 0; i < b.count && n < max; i++) {
    const age = s.time - b.birth[i];
    const amp = RING_AMP * b.amp[i] * ringAmplitude(age, RING_LIFE);
    if (amp <= 1e-4) continue;
    const rho = s.dist - b.birthDist[i];
    const lambda = RING_WAVELENGTH * (1 + RING_SPREAD * age);
    const w = PACKET_HALF * lambda;
    const rOut = rho + w;
    const k = TAU / lambda;
    const z = range[0] + b.y[i] * (range[1] - range[0]);
    const u = RING_U_EDGE + (1 - 2 * RING_U_EDGE) * b.x[i];
    const o = n * RING_STRIDE;
    out[o] = (u - 0.5) * aspect * z;
    out[o + 1] = z;
    out[o + 2] = rOut * rOut;
    out[o + 3] = 1 / (w * k);
    out[o + 4] = rho;
    out[o + 5] = 1 / w;
    out[o + 6] = k;
    out[o + 7] = amp;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Wind

/** Width of the mask's soft edge, in noise units. */
export const WIND_SOFT = 0.16;
/** A threshold no noise value reaches: no patches. */
export const WIND_OFF = 2;

/** Slow gust envelope in [0, 1]: two incommensurate sines. */
export function windGust(t: number): number {
  return 0.5 + 0.3 * Math.sin(t * 0.13 + 0.7) + 0.2 * Math.sin(t * 0.047 + 2.3);
}

/**
 * The noise level above which the water is ruffled at `wind` (0..1) and time
 * `t`: lower with more wind, and swinging slowly with the gusts so patches grow
 * and fade. `WIND_OFF` when there is no wind.
 */
export function windThreshold(wind: number, t: number): number {
  const w = Number.isFinite(wind) ? clamp(wind, 0, 1) : 0;
  if (w <= 0) return WIND_OFF;
  return 0.78 - 0.45 * w + 0.16 * (0.5 - windGust(t));
}

/** Slope of fully ruffled water at `wind` (0..1). */
export function windSlope(wind: number): number {
  const w = Number.isFinite(wind) ? clamp(wind, 0, 1) : 0;
  return 0.12 + 0.18 * w;
}

/**
 * The wind-patch mask for a low-frequency noise value `n` (about 0..1): 0 below
 * the threshold, easing to 1 over `WIND_SOFT`. The JS twin of the shader's.
 */
export function windMask(n: number, threshold: number): number {
  const m = smoothstep(threshold, threshold + WIND_SOFT, n);
  return m >= 0 && m <= 1 ? m : 0;
}
