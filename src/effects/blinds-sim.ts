/**
 * Pure logic for the "Light through blinds" effect: the band layout, the stripe and
 * window-mask function (the JS twin of the fragment shader, used to light the dust
 * motes), and the cloud-dimming curve. Allocates nothing per call.
 */
import type { Rgb } from "./color";
import { clamp, fract, smoothstep } from "./math";
import type { Noise } from "./noise";
import { lookup } from "./lookup";

/** Lit fraction of each stripe period (the gap between two slats). */
export const DUTY = 0.56;
/** Half the duty cycle, in stripe periods: the lit gap reaches this far from its centre. */
export const HALF_DUTY = DUTY / 2;
/** Soft side-edge half-width of the window mask (in `xn` units) at the window end and its growth to the far end. */
export const EDGE_X0 = 0.02;
export const EDGE_XK = 0.08;
/** Soft top/bottom edge half-width of the window mask (in `w` units), window end and growth. */
export const EDGE_Y0 = 0.015;
export const EDGE_YK = 0.04;
/** How much dimmer the far end of the band is than the window end. */
export const FALLOFF = 0.3;
/**
 * Largest |xn| and |w| at which the mask is non-zero, plus a little: motes wrap
 * outside this, where they are invisible.
 */
export const BOX_X = 1 + EDGE_X0 + EDGE_XK + 0.05;
export const BOX_W = 0.5 + EDGE_Y0 + EDGE_YK + 0.05;

/**
 * The band of stripes in reference units (1080 tall, y down). The window footprint
 * is a parallelogram: its sides are vertical lines (the window's vertical frame
 * casts vertical shadows on a vertical wall) `halfW` either side of `cx`, and its
 * top and bottom run parallel to the stripes, `bandH / 2` above and below the
 * centre line `y = cy + slope * (x - cx)`.
 */
export interface BlindsShape {
  cx: number;
  cy: number;
  halfW: number;
  bandH: number;
  /** dy/dx of the stripes (y down). */
  slope: number;
  slats: number;
  /** +1 when the window (sharp end) is to the right of the band, -1 to the left. */
  side: number;
  /** Penumbra width in stripe periods at the window end, and its growth to the far end. */
  pen0: number;
  penK: number;
}

export const POSITIONS = {
  topRight: { x: 0.74, y: 0.3, side: 1 },
  topLeft: { x: 0.26, y: 0.3, side: -1 },
  right: { x: 0.76, y: 0.56, side: 1 },
  left: { x: 0.24, y: 0.56, side: -1 },
} as const;
export type Position = keyof typeof POSITIONS;

/** Footprint half-width as a fraction of the reference width, and band height in reference px. */
const HALF_W = 0.19;
const BAND_H = 560;

export function createShape(): BlindsShape {
  return { cx: 0, cy: 0, halfW: 1, bandH: 1, slope: 0, slats: 1, side: 1, pen0: 0.1, penK: 0 };
}

/**
 * Lays the band out into `out` for a frame `refWidth` wide. `angleDeg` is the
 * stripe angle from horizontal; the stripes rise towards the window side.
 */
export function layoutShape(
  out: BlindsShape,
  position: string,
  refWidth: number,
  angleDeg: number,
  slats: number,
  softness: number,
): BlindsShape {
  const pos = lookup(POSITIONS, position, "topRight");
  out.cx = pos.x * refWidth;
  out.cy = pos.y * 1080;
  out.halfW = Math.max(1, HALF_W * refWidth);
  out.bandH = BAND_H;
  out.side = pos.side;
  out.slope = -pos.side * Math.tan((clamp(angleDeg, -80, 80) * Math.PI) / 180);
  out.slats = Math.max(1, Math.round(slats));
  const s = clamp(softness, 0, 1);
  out.pen0 = 0.07 + 0.25 * s;
  out.penK = 0.12 + 0.5 * s;
  return out;
}

/** Horizontal band coordinate: -1 and 1 at the footprint's vertical sides. */
export function bandX(x: number, s: BlindsShape): number {
  return (x - s.cx) / s.halfW;
}

/** Across-stripe band coordinate: -0.5 and 0.5 at the footprint's top and bottom edges. */
export function bandW(x: number, y: number, s: BlindsShape): number {
  return (y - s.cy - s.slope * (x - s.cx)) / s.bandH;
}

/** Distance along the band from the window end: 0 there, 1 at the far end. */
export function bandT(xn: number, side: number): number {
  return clamp(0.5 - 0.5 * xn * side, 0, 1);
}

/**
 * Stripe profile at stripe phase `n` (in periods; lit gaps centred on half-integers)
 * with penumbra `pen` (in periods). 1 in the lit gap, 0 behind a slat.
 */
export function stripe(n: number, pen: number): number {
  const g = Math.abs(fract(n) - 0.5);
  return 1 - smoothstep(HALF_DUTY - 0.5 * pen, HALF_DUTY + 0.5 * pen, g);
}

/**
 * Light on the wall at band coordinates (`xn`, `w`): stripe times window mask
 * times the gentle falloff away from the window, in [0, 1]. The fragment shader
 * computes the same expression.
 */
export function blindsLightBand(xn: number, w: number, s: BlindsShape): number {
  const t = bandT(xn, s.side);
  const st = stripe((w + 0.5) * s.slats, s.pen0 + s.penK * t);
  const ex = EDGE_X0 + EDGE_XK * t;
  const ey = EDGE_Y0 + EDGE_YK * t;
  const mx = 1 - smoothstep(1 - ex, 1 + ex, Math.abs(xn));
  const my = 1 - smoothstep(0.5 - ey, 0.5 + ey, Math.abs(w));
  return st * mx * my * (1 - FALLOFF * t);
}

/** `blindsLightBand` at reference-unit point (x, y). */
export function blindsLight(x: number, y: number, s: BlindsShape): number {
  return blindsLightBand(bandX(x, s), bandW(x, y, s), s);
}

/** Cloud noise frequency in 1/s: features about 30 s apart, so dips come every 20–60 s. */
export const CLOUD_FREQ = 1 / 30;
/** Deepest dip: the sun loses up to half its light. */
export const MAX_DIP = 0.5;

/**
 * Sun level (1 = clear, down to 1 - MAX_DIP) for a cloud noise value `n` (roughly
 * -1..1) and `clouds` in 0..1. More clouds lower the threshold (more frequent
 * dips) and deepen them. Continuous in `n` and `clouds`; exactly 1 at clouds 0.
 */
export function sunLevel(n: number, clouds: number): number {
  const c = clamp(clouds, 0, 1);
  if (c <= 0) return 1;
  // The wide ramp keeps the dimming slow: the noise changes by at most about
  // 0.2 per second, so the deepest dip takes three seconds or more.
  const threshold = 0.6 - 0.9 * c;
  const cover = smoothstep(threshold, threshold + 0.8, n);
  return 1 - MAX_DIP * Math.sqrt(c) * cover;
}

/** `sunLevel` at `time` seconds, sampling 1D noise (a fixed row of `noise2`). */
export function sunLevelAt(noise: Noise, time: number, clouds: number): number {
  if (clouds <= 0) return 1;
  return sunLevel(noise.noise2(time * CLOUD_FREQ, 3.7), clouds);
}

/** Colour multipliers for the sun at its deepest dip: cooler and slightly greyer. */
export const DIM_TINT: Rgb = [0.86, 0.95, 1.12];

/**
 * Writes the sun's colour at `level` into `out`: `light` times `level` times
 * `gain`, shifted towards `DIM_TINT` as the level dips.
 */
export function sunColor(out: Rgb, light: Rgb, level: number, gain: number): Rgb {
  const k = clamp((1 - level) / MAX_DIP, 0, 1);
  const g = level * gain;
  for (let i = 0; i < 3; i++) out[i] = light[i] * (1 + k * (DIM_TINT[i] - 1)) * g;
  return out;
}
