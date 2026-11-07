/**
 * Pure JS parts of the sand dunes effect: the ridge layout, the per-column ridge
 * table (height, slope and the horizon angles that give cast shadows) and the
 * slow sun path. Kept free of GL so they can be unit-tested.
 *
 * Units: "height units", where the canvas is 1 tall and `aspect` wide, with y up
 * from the bottom edge (matching `gl_FragCoord / height`).
 */
import { hash32, createRng } from "../noise";
import { clamp, fract, smoothstep } from "../math";
import { MAX_CREST_SOFTNESS } from "./dunes.meta";

/** Columns in the ridge table, spread across the canvas width. */
export const TABLE_COLUMNS = 2048;
/** Floats per table texel: relative height, slope, left and right horizon angles. */
export const TABLE_CHANNELS = 4;
/** Where the sky gradient starts, and the farthest ridge sits just under it. */
export const HORIZON = 0.46;
/**
 * Extra profile generated past each side edge (height units), so shadows cast by
 * dunes just off-screen still land on the visible ones.
 */
export const SHADOW_MARGIN = 0.6;
/** Floats per ridge in the layout: base, face depth, haze, ripple weight. */
export const LAYOUT_FLOATS = 4;
/** Fraction of each dune's period taken by the gentle windward slope (the rest is the lee). */
const WINDWARD = 0.68;

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export interface RidgeShape {
  /** Height (height units) of the ridge's troughs. */
  base: number;
  /** Height of a full dune above `base`. */
  amp: number;
  /** Dune period along x, in height units. */
  wavelength: number;
}

/** Shape of ridge `i` (0 = nearest) of `count`: farther ridges sit higher, lower and tighter. */
export function ridgeShape(i: number, count: number): RidgeShape {
  const d = count > 1 ? i / (count - 1) : 0;
  return {
    base: mix(0.06, HORIZON - 0.02, d ** 0.7),
    amp: mix(0.24, 0.03, d ** 0.6),
    wavelength: mix(1.3, 0.3, d ** 0.8),
  };
}

/**
 * Fills `out` (`MAX_RIDGES * LAYOUT_FLOATS`) with each ridge's shader constants:
 * base height, face depth (the height over which its face turns toward the
 * viewer), aerial-perspective haze (0 near) and ripple weight (near ridges only).
 * Unused ridges are zero.
 */
export function fillLayout(out: Float32Array, count: number, ripples: number): void {
  out.fill(0);
  let prevBase = 0;
  for (let i = 0; i < count; i++) {
    const { base, amp } = ridgeShape(i, count);
    const d = count > 1 ? i / (count - 1) : 0;
    const o = i * LAYOUT_FLOATS;
    out[o] = base;
    out[o + 1] = amp + (base - prevBase);
    out[o + 2] = 0.65 * d ** 1.2;
    out[o + 3] = (i === 0 ? 0.22 : i === 1 ? 0.1 : 0) * ripples;
    prevBase = base;
  }
}

/**
 * Softness up to this rounds the crest with the smooth minimum in `duneShape`
 * (rounding = softness times the dune's height). Any wider and the blend would
 * reach the lee trough, where the two parabolas are only about 2.2 apart, and
 * pull it below the base, so softness beyond it blurs the profile instead.
 */
export const SMOOTH_MIN_SOFTNESS = 2;
/** Profile blur (Gaussian sigma, in dune wavelengths) per unit of softness above SMOOTH_MIN_SOFTNESS. */
export const BLUR_PER_SOFTNESS = 0.03;

/**
 * One dune: 0 at the troughs, 1 at the crest, with smooth troughs. The crest is
 * where the windward parabola meets the steeper lee one; `softness` (0..SMOOTH_MIN_SOFTNESS; more is clamped)
 * rounds it off with a polynomial smooth minimum of the two, so the slope turns
 * over gradually instead of flipping at a sharp ridge line. 0 keeps the sharp
 * crest. The result is rescaled so the rounded crest still peaks at exactly 1.
 */
export function duneShape(u: number, softness = 0): number {
  const k = clamp(softness, 0, SMOOTH_MIN_SOFTNESS);
  if (k <= 0) {
    return roundedDune(u, 0);
  }
  return roundedDune(u, k) / crestPeak(k);
}

/** Smooth min (rounding `k`, 0 = plain min) of a dune's windward and lee parabolas. */
function roundedDune(u: number, k: number): number {
  const a = u / WINDWARD;
  const b = (1 - u) / (1 - WINDWARD);
  const wind = a * a;
  const lee = b * b;
  if (k <= 0) {
    return Math.min(wind, lee);
  }
  // Polynomial smooth min: equal to min() where the curves are more than k apart.
  const h = Math.max(k - Math.abs(wind - lee), 0) / k;
  return Math.min(wind, lee) - h * h * k * 0.25;
}

let peakK = Number.NaN;
let peakValue = 1;
/**
 * Highest value of `roundedDune(·, k)`, by ternary search (it is unimodal),
 * cached for the last `k`: the table rebuild calls `duneShape` with one softness.
 */
function crestPeak(k: number): number {
  if (k === peakK) {
    return peakValue;
  }
  let lo = 0.3;
  let hi = 0.95;
  for (let i = 0; i < 80; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (roundedDune(m1, k) < roundedDune(m2, k)) {
      lo = m1;
    } else {
      hi = m2;
    }
  }
  peakK = k;
  peakValue = roundedDune((lo + hi) / 2, k);
  return peakValue;
}

/** Per-ridge random constants for `profile`, from the seed. */
export interface ProfileParams {
  wavelength: number;
  offset: number;
  warpFreq: number;
  warpPhase: number;
  swellFreq: number;
  swellPhase: number;
  detailOffset: number;
  /** Hash salt for each dune's own height. */
  salt: number;
  /** Crest rounding, 0..MAX_CREST_SOFTNESS (see `duneShape`). */
  softness: number;
}

export function profileParams(seed: number, i: number, count: number, softness = 0): ProfileParams {
  const rand = createRng(hash32(seed * 7919 + i * 104729 + 17));
  const { wavelength } = ridgeShape(i, count);
  return {
    wavelength,
    offset: rand() * 10,
    warpFreq: (2 * Math.PI) / (wavelength * (3 + rand() * 1.5)),
    warpPhase: rand() * 2 * Math.PI,
    swellFreq: (2 * Math.PI) / (wavelength * (4 + rand() * 3)),
    swellPhase: rand() * 2 * Math.PI,
    detailOffset: rand() * 10,
    salt: hash32(seed * 31 + i * 977 + 5),
    softness,
  };
}

/**
 * Ridge profile at world x (height units, 0 = canvas centre), in 0..1 of the
 * ridge's amplitude: big dunes of random heights, a few small secondary dunes and
 * a slow swell. The phase warp varies the dune spacing but stays monotonic.
 */
export function profile(x: number, p: ProfileParams): number {
  const phase = x / p.wavelength + p.offset + 0.25 * Math.sin(x * p.warpFreq + p.warpPhase);
  const n = Math.floor(phase);
  const height = 0.55 + 0.45 * (hash32(p.salt ^ n) / 4294967296);
  const main = duneShape(phase - n, p.softness) * height;
  const detail = duneShape(fract(phase * 2.7 + p.detailOffset), p.softness);
  const swell = 0.5 + 0.5 * Math.sin(x * p.swellFreq + p.swellPhase);
  return 0.75 * main + 0.1 * detail + 0.15 * swell;
}

/**
 * Horizon angles of a sampled 1D height profile (spacing `dx`): for each sample,
 * the highest elevation angle (radians) at which any other sample on that side
 * is seen. A point is in shadow when the sun is lower than the horizon angle on
 * its side. Linear time, using the upper convex hull of the points passed so far.
 * Samples with nothing on a side get -PI / 2.
 */
export function horizonAngles(
  h: Float64Array,
  dx: number,
  left: Float64Array,
  right: Float64Array,
  stack: Int32Array,
): void {
  const n = h.length;
  for (let pass = 0; pass < 2; pass++) {
    const out = pass === 0 ? left : right;
    let top = 0;
    for (let k = 0; k < n; k++) {
      const j = pass === 0 ? k : n - 1 - k;
      // Pop hull points hidden behind the next one, seen from j.
      while (top >= 2) {
        const a = stack[top - 1];
        const b = stack[top - 2];
        const sa = (h[a] - h[j]) / Math.abs(j - a);
        const sb = (h[b] - h[j]) / Math.abs(j - b);
        if (sa > sb) {
          break;
        }
        top--;
      }
      if (top === 0) {
        out[j] = -Math.PI / 2;
      } else {
        const a = stack[top - 1];
        out[j] = Math.atan2(h[a] - h[j], Math.abs(j - a) * dx);
      }
      stack[top++] = j;
    }
  }
}

/**
 * Blurs `h` in place with an approximate Gaussian of `sigma` samples: three box
 * passes with running sums (linear time whatever the width), edges clamped.
 * Averaging keeps every value within the original range. `tmp` is scratch, at
 * least as long as `h`.
 */
export function blurProfile(h: Float64Array, tmp: Float64Array, sigma: number): void {
  // Three box passes of radius r have variance r (r + 1).
  const r = Math.round((Math.sqrt(1 + 4 * sigma * sigma) - 1) / 2);
  if (!(r >= 1)) {
    return;
  }
  const n = h.length;
  const last = n - 1;
  const inv = 1 / (2 * r + 1);
  for (let pass = 0; pass < 3; pass++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      sum += h[Math.min(last, Math.max(0, k))];
    }
    for (let j = 0; j < n; j++) {
      tmp[j] = sum * inv;
      sum += h[Math.min(last, j + r + 1)] - h[Math.max(0, j - r)];
    }
    h.set(tmp.subarray(0, n));
  }
}

/** Reusable buffers for `fillRidgeTable`, so rebuilding allocates only when they grow. */
export interface TableScratch {
  h: Float64Array;
  left: Float64Array;
  right: Float64Array;
  stack: Int32Array;
}

export const createTableScratch = (): TableScratch => ({
  h: new Float64Array(0),
  left: new Float64Array(0),
  right: new Float64Array(0),
  stack: new Int32Array(0),
});

/**
 * Fills the ridge table (`MAX_RIDGES` rows of `TABLE_COLUMNS` RGBA texels, row i
 * = ridge i, nearest first) for a canvas `aspect` wide: column j sits at
 * x = j / (TABLE_COLUMNS - 1) * aspect. Each texel holds the height above the
 * ridge's base, the slope dh/dx, and the left and right horizon angles.
 * `softness` rounds the crests: up to SMOOTH_MIN_SOFTNESS through `duneShape`,
 * and beyond that also by blurring each sampled profile (`blurProfile`).
 */
export function fillRidgeTable(
  out: Float32Array,
  count: number,
  aspect: number,
  seed: number,
  scratch: TableScratch = createTableScratch(),
  softness = 0,
): void {
  out.fill(0);
  const cols = TABLE_COLUMNS;
  const dx = aspect / (cols - 1);
  const margin = Math.ceil(SHADOW_MARGIN / dx);
  const n = cols + 2 * margin;
  if (scratch.h.length !== n) {
    scratch.h = new Float64Array(n);
    scratch.left = new Float64Array(n);
    scratch.right = new Float64Array(n);
    scratch.stack = new Int32Array(n);
  }
  const { h, left, right, stack } = scratch;
  for (let i = 0; i < count; i++) {
    const shape = ridgeShape(i, count);
    const params = profileParams(seed, i, count, softness);
    for (let k = 0; k < n; k++) {
      const x = (k - margin) * dx - aspect / 2;
      h[k] = shape.base + shape.amp * profile(x, params);
    }
    const extra = clamp(softness, 0, MAX_CREST_SOFTNESS) - SMOOTH_MIN_SOFTNESS;
    if (extra > 0) {
      // `left` is free until horizonAngles fills it.
      blurProfile(h, left, (extra * BLUR_PER_SOFTNESS * shape.wavelength) / dx);
    }
    horizonAngles(h, dx, left, right, stack);
    const row = i * cols * TABLE_CHANNELS;
    for (let j = 0; j < cols; j++) {
      const k = j + margin;
      const o = row + j * TABLE_CHANNELS;
      out[o] = h[k] - shape.base;
      out[o + 1] = (h[k + 1] - h[k - 1]) / (2 * dx);
      out[o + 2] = left[k];
      out[o + 3] = right[k];
    }
  }
}

/** Sun elevation range (radians): golden hour to midday. */
export const SUN_ELEVATION_MIN = 0.09;
export const SUN_ELEVATION_MAX = 1.05;
/**
 * Sun azimuth range (radians from straight ahead, negative = left): low on the
 * left at golden hour, so the lee faces of the dunes (facing right) are in shadow,
 * swinging toward the centre as it rises.
 */
export const SUN_AZIMUTH_LOW = -0.55;
export const SUN_AZIMUTH_HIGH = -0.22;
const AZIMUTH_WOBBLE = 0.06;

/** Elevation and azimuth in radians. */
export interface SunPosition {
  elevation: number;
  azimuth: number;
}

/**
 * Sun position at `phase` (any number; period 1): it rises from golden hour to
 * midday and back down, smoothly, with a little sideways wobble so the path is a
 * narrow loop rather than a line.
 */
export function sunAt(phase: number, out: SunPosition): SunPosition {
  const a = 2 * Math.PI * phase;
  const k = 0.5 - 0.5 * Math.cos(a);
  out.elevation = mix(SUN_ELEVATION_MIN, SUN_ELEVATION_MAX, k);
  out.azimuth = mix(SUN_AZIMUTH_LOW, SUN_AZIMUTH_HIGH, k) + AZIMUTH_WOBBLE * Math.sin(a);
  return out;
}

/** Phase (0..0.5, on the rising half) at which the sun is at `height` (0..1) of its range. */
export function startPhase(height: number): number {
  return Math.acos(1 - 2 * clamp(height, 0, 1)) / (2 * Math.PI);
}

/** How golden the light is (1 at a low sun, 0 by mid-morning), from sin(elevation). */
export const goldenness = (sinElevation: number) => 1 - smoothstep(0.08, 0.55, sinElevation);
