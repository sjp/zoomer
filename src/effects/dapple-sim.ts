/**
 * Pure logic for the "Dappled sunlight" effect: the canopy layers' sway and gust
 * curves, the coverage-to-threshold mapping, the sun-angle sampling basis, and the
 * soft region and window-frame masks (JS twins of the shader). Allocates nothing
 * per call.
 */
import { clamp, fract, smoothstep } from "./math";
import type { Noise } from "./noise";

const TAU = Math.PI * 2;

/** Noise texture: texels per side and lattice cells per side (all four channels). */
export const NOISE_SIZE = 128;
export const NOISE_PERIOD = 8;
/** Channel seeds: near leaves, mid leaves, far branches, plaster. */
export const NOISE_SEEDS = [351, 352, 353, 25] as const;

/** Weights of the near and mid layers in the summed spot noise. */
export const NEAR_WEIGHT = 0.6;
export const MID_WEIGHT = 0.4;
/**
 * Standard deviation of the summed spot noise (texture units, mean 0.5), measured
 * from the texture. The summed noise is close to Gaussian, which the coverage
 * mapping relies on.
 */
export const SPOT_SIGMA = 0.106;
/** Logistic approximation of the Gaussian quantile: probit(p) ~ logit(p) / 1.702. */
const LOGIT_TO_PROBIT = 1 / 1.702;

/**
 * Canopy layers: lattice cell size in reference px (bigger is softer and
 * blurrier), sway amplitude in reference px at sway 1, sway period in seconds,
 * phase, the vertical share of the sway, and how fast the layer follows the sun
 * drift (different rates make the pattern slowly evolve).
 */
export const LAYERS = [
  { cell: 110, amp: 6, period: 3.7, phase: 0, lift: 0.45, drift: 1 },
  { cell: 260, amp: 5, period: 5.3, phase: 2.1, lift: 0.35, drift: 0.85 },
  { cell: 720, amp: 3, period: 7.9, phase: 4.4, lift: 0.25, drift: 0.6 },
] as const;
export const LAYER_COUNT = LAYERS.length;

/** Vertical sway runs this much faster than horizontal, so the path is a slow Lissajous. */
const LIFT_FREQ = 1.37;
/** Tiny noise wobble added to the sway, as a fraction of the amplitude, and its rate in 1/s. */
const WOBBLE = 0.15;
const WOBBLE_FREQ = 0.15;

/** Gust noise frequency in 1/s (features tens of seconds apart) and the largest extra sway. */
export const GUST_FREQ = 1 / 30;
export const GUST_MAX = 1;

/** Sun drift speed in reference px per second (slow: a few hundred px an hour). */
export const DRIFT_SPEED = 0.08;

/** Spot elongation along the sun direction. */
export const STRETCH = 1.35;

/**
 * Sway amplitude multiplier at `time` seconds: 1 in still air, up to
 * `1 + GUST_MAX * gusts` during a gust. Changes over tens of seconds.
 */
export function gustLevel(noise: Noise, time: number, gusts: number): number {
  const g = clamp(gusts, 0, 1);
  if (g <= 0) return 1;
  return 1 + GUST_MAX * g * smoothstep(0, 0.7, noise.noise2(time * GUST_FREQ, 9.1));
}

/** Largest |sway| on either axis of `layer`, in reference px, at sway 1 and gust `gust`. */
export function swayBound(layer: number, gust: number): number {
  return LAYERS[layer].amp * gust * (1 + WOBBLE);
}

/**
 * Writes the sway offset of canopy `layer` at `time` seconds into `out` (reference
 * px): `amp * sway * gust * sin(w t + phase)` horizontally, a smaller sine
 * vertically, plus a tiny noise wobble. Time stays unwrapped (float64); only the
 * phase is wrapped.
 */
export function swayOffset(
  out: Float64Array,
  noise: Noise,
  layer: number,
  time: number,
  sway: number,
  gust: number,
): Float64Array {
  const l = LAYERS[layer];
  const a = l.amp * clamp(sway, 0, 1) * gust;
  const ph = fract(time / l.period) * TAU + l.phase;
  const phY = fract((time * LIFT_FREQ) / l.period) * TAU + l.phase * 1.7;
  const wt = time * WOBBLE_FREQ;
  out[0] = a * (Math.sin(ph) + WOBBLE * noise.noise2(wt, layer * 7.3));
  out[1] = a * l.lift * (Math.sin(phY) + WOBBLE * noise.noise2(wt, layer * 7.3 + 3.1));
  return out;
}

/** Spot softness param (0..1) to the smoothstep half-width in noise units. */
export function softnessWidth(softness: number): number {
  return 0.012 + 0.07 * clamp(softness, 0, 1);
}

/**
 * Coverage (0..1, the lit fraction of the patch) to the spot threshold `t` for a
 * smoothstep half-width `s`: lit where `smoothstep(t - s, t + s, n) > 0`. Uses the
 * near-Gaussian distribution of the summed noise so the slider is even, and
 * reaches `1 + s` (nothing lit) at 0 and `-s` (all lit) at 1. Non-increasing.
 */
export function coverageThreshold(coverage: number, s: number): number {
  const c = clamp(coverage, 0, 1);
  const lo = -s;
  const hi = 1 + s;
  if (c <= 0) return hi;
  if (c >= 1) return lo;
  return clamp(0.5 - SPOT_SIGMA * LOGIT_TO_PROBIT * Math.log(c / (1 - c)), lo, hi);
}

/**
 * Writes the sampling basis into `out` as a column-major mat2 (GLSL
 * `mat2(vec4)`): wall reference px to "sun" coordinates, where the axis along the
 * sun direction (`angleDeg` off vertical, y down) is squeezed by `STRETCH`, so
 * round noise blobs land on the wall as ellipses stretched along it.
 */
export function sunBasis(out: Float32Array | Float64Array, angleDeg: number) {
  const a = (clamp(angleDeg, -80, 80) * Math.PI) / 180;
  const sx = Math.sin(a);
  const sy = Math.cos(a);
  // Rows: across = (sy, -sx), along = (sx, sy) / STRETCH.
  out[0] = sy;
  out[1] = sx / STRETCH;
  out[2] = -sx;
  out[3] = sy / STRETCH;
  return out;
}

/**
 * Lit regions. `top`: the lit band reaches down to this y (reference px; huge for
 * "Full"). `side`: +1 a band on the right, -1 on the left, 0 none; it reaches
 * `sideW` (fraction of the reference width) in from that edge. `frame`: window
 * cross centre as fractions of the frame.
 */
export const REGIONS = {
  topRight: { top: 330, side: 1, sideW: 0.27, frame: [0.83, 0.17] },
  topLeft: { top: 330, side: -1, sideW: 0.27, frame: [0.17, 0.17] },
  right: { top: -1e4, side: 1, sideW: 0.3, frame: [0.85, 0.5] },
  left: { top: -1e4, side: -1, sideW: 0.3, frame: [0.15, 0.5] },
  full: { top: 1e4, side: 0, sideW: 0, frame: [0.7, 0.3] },
} as const;
export type Region = keyof typeof REGIONS;

export const POSITION_OPTIONS = [
  { value: "topRight", label: "Top right" },
  { value: "topLeft", label: "Top left" },
  { value: "right", label: "Right" },
  { value: "left", label: "Left" },
  { value: "full", label: "Full" },
] as const;

/** Half-width of the region's soft edge in reference px. */
export const REGION_SOFT = 150;

/** Region layout for the shader (all reference px). */
export interface RegionLayout {
  /** y of the top band's edge (soft either side). */
  topY: number;
  /** x of the frame edge the side band hangs from, and +1 / -1 / 0 for its side. */
  edgeX: number;
  side: number;
  /** How far the side band reaches in from `edgeX`. */
  sideW: number;
  /** Window-frame cross centre. */
  frameX: number;
  frameY: number;
}

export function createRegionLayout(): RegionLayout {
  return { topY: 0, edgeX: 0, side: 0, sideW: 0, frameX: 0, frameY: 0 };
}

export function layoutRegion(out: RegionLayout, position: string, refWidth: number) {
  const r = Object.hasOwn(REGIONS, position) ? REGIONS[position as Region] : REGIONS.topRight;
  out.topY = r.top;
  out.side = r.side;
  out.edgeX = r.side > 0 ? refWidth : 0;
  out.sideW = r.sideW * refWidth;
  out.frameX = r.frame[0] * refWidth;
  out.frameY = r.frame[1] * 1080;
  return out;
}

/**
 * Soft region mask at reference point (x, y): 1 inside the lit band(s), 0 more
 * than `REGION_SOFT` outside, smooth between. The top and side bands combine as
 * a soft union. The shader computes the same expression.
 */
export function regionMask(x: number, y: number, r: RegionLayout): number {
  const top = 1 - smoothstep(r.topY - REGION_SOFT, r.topY + REGION_SOFT, y);
  const d = (r.edgeX - x) * r.side;
  const side = r.side === 0 ? 0 : 1 - smoothstep(r.sideW - REGION_SOFT, r.sideW + REGION_SOFT, d);
  return 1 - (1 - top) * (1 - side);
}

/** Window-frame shadow: bar half-width and penumbra half-width in reference px, and depth. */
export const FRAME_HALF = 16;
export const FRAME_SOFT = 14;
export const FRAME_DEPTH = 0.85;

/** Window-frame multiplier at (x, y): 1 - depth on the cross, 1 away from it. */
export function frameMask(x: number, y: number, r: RegionLayout): number {
  const bx =
    1 - smoothstep(FRAME_HALF - FRAME_SOFT, FRAME_HALF + FRAME_SOFT, Math.abs(x - r.frameX));
  const by =
    1 - smoothstep(FRAME_HALF - FRAME_SOFT, FRAME_HALF + FRAME_SOFT, Math.abs(y - r.frameY));
  return 1 - FRAME_DEPTH * Math.max(bx, by);
}
