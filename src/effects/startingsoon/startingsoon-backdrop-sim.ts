/**
 * The Starting Soon backdrops' pure parts, kept free of GL so they can be
 * tested: colours drawn from the accent, the pixel window's geometry and its
 * rain speed, and the floating shapes' drift.
 */
import type { Rgb } from "../color";
import { clamp, wrap } from "../math";
import { createRng, hash32 } from "../noise";
import { RAIN_TOP, rainFloor, rainSpeed } from "../porch/porch-sim";

// ---------------------------------------------------------------- Colours

/** `rgb` (0..1) turned `degrees` round the hue circle, keeping its lightness and saturation. */
export function rotateHue(rgb: Readonly<Rgb>, degrees: number, out: Rgb): Rgb {
  // Rodrigues' rotation about the grey axis.
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a) / Math.sqrt(3);
  const k = (1 - c) / 3;
  const [r, g, b] = rgb;
  out[0] = clamp(r * (c + k) + g * (k - s) + b * (k + s), 0, 1);
  out[1] = clamp(r * (k + s) + g * (c + k) + b * (k - s), 0, 1);
  out[2] = clamp(r * (k - s) + g * (k + s) + b * (c + k), 0, 1);
  return out;
}

/** Hue turns (degrees) and brightness of the blob colours, from the accent. */
const BLOB_TINTS: readonly (readonly [number, number])[] = [
  [0, 0.75],
  [55, 0.55],
  [-60, 0.6],
  [180, 0.35],
  [25, 0.45],
  [-25, 0.5],
];

/**
 * The blob colours for `accent` (0..1 sRGB), as linear light (`gamma`) into
 * `out`, three floats per blob: the accent and hues either side of it, dimmed
 * so white text stays easy to read over them. Allocates nothing.
 */
export function blobColours(
  accent: Readonly<Rgb>,
  gamma: number,
  out: Float32Array,
  scratch: Rgb = [0, 0, 0],
): Float32Array {
  const n = Math.min(BLOB_TINTS.length, Math.floor(out.length / 3));
  for (let i = 0; i < n; i++) {
    const [turn, gain] = BLOB_TINTS[i];
    rotateHue(accent, turn, scratch);
    for (let c = 0; c < 3; c++) {
      out[i * 3 + c] = (scratch[c] * gain) ** gamma;
    }
  }
  return out;
}

// ---------------------------------------------------------------- Pixel window

/**
 * The rainy room's layout in design units (frame heights, origin at the
 * frame's centre, y up), for a frame `aspect` wide: the window's centre and
 * half size, the frame's thickness, and where the lamp stands.
 */
interface WindowGeometry {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  /** Width of the frame round the glass and of the cross bars. */
  bar: number;
  /** Height of the cross bar's centre above the window's centre. */
  crossY: number;
  /** The lamp's base, on the desk, and the desk top's height. */
  lampX: number;
  deskY: number;
}

export const createWindowGeometry = (): WindowGeometry => ({
  cx: 0,
  cy: 0,
  hw: 0,
  hh: 0,
  bar: 0,
  crossY: 0,
  lampX: 0,
  deskY: 0,
});

/** Writes the room's layout for a frame `aspect` wide into `out`. */
export function windowGeometry(aspect: number, out: WindowGeometry): WindowGeometry {
  const half = 0.5 * (Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9);
  out.cx = 0;
  out.cy = 0.08;
  out.hw = Math.max(0.12, Math.min(0.5, half - 0.1));
  out.hh = 0.29;
  out.bar = 0.022;
  out.crossY = 0.06;
  out.deskY = -0.33;
  // Beside the window where there is room, otherwise in front of its corner.
  out.lampX = Math.max(half * 0.55, Math.min(out.hw + 0.2, half - 0.16));
  return out;
}

/** Rain drops in the window. */
export const RAIN_DROPS = 150;
/** The window's rain runs at this share of the porch rain's pace: slow enough for a codec. */
export const RAIN_PACE = 0.35;

/**
 * How fast (frame heights per second) a drop of `depth` (0 far, 1 near) falls
 * past a window `windowHeight` frame heights tall: its fall from the top to its
 * floor fills the window's height.
 */
export function windowRainSpeed(depth: number, windowHeight: number): number {
  const fall = rainFloor(depth) - RAIN_TOP;
  return (rainSpeed(depth) * RAIN_PACE * windowHeight) / fall;
}

/** How far down its fall (0 top, 1 floor) a drop at height `y` of depth `depth` is. */
export const rainProgress = (y: number, depth: number) =>
  (y - RAIN_TOP) / (rainFloor(depth) - RAIN_TOP);

// ---------------------------------------------------------------- Shapes

/** Floating shapes. */
export const SHAPE_COUNT = 18;
/** Shape kinds: ring, triangle, square, plus, dot. */
const SHAPE_KINDS = 5;
/** Margin (reference px) past the frame where shapes wrap, beyond their largest size. */
export const SHAPE_MARGIN = 120;
/** Rise speeds (reference px/s) and half sizes (reference px). */
const RISE: readonly [number, number] = [7, 16];
const SIZE: readonly [number, number] = [18, 56];
/** Most spin, radians per second. */
export const MAX_SPIN = 0.18;
/** Sideways sway: amplitude (reference px) and period range (s). */
const SWAY = 24;
const SWAY_PERIOD: readonly [number, number] = [14, 26];

interface Shapes {
  /** Across the frame (0..1 of its width), before the sway. */
  readonly x: Float32Array;
  /** Reference px down from the frame's top. */
  readonly y: Float32Array;
  readonly half: Float32Array;
  readonly kind: Uint8Array;
  readonly rise: Float32Array;
  readonly spin: Float32Array;
  readonly swayRate: Float32Array;
  readonly phase: Float32Array;
  /** 0..1 hue pick and opacity. */
  readonly hue: Float32Array;
  readonly alpha: Float32Array;
  /** Seconds of drift so far. */
  time: number;
}

/** `count` shapes scattered over the frame, each from its own hash (so a prefix is the same set). */
export function createShapes(count: number): Shapes {
  const s: Shapes = {
    x: new Float32Array(count),
    y: new Float32Array(count),
    half: new Float32Array(count),
    kind: new Uint8Array(count),
    rise: new Float32Array(count),
    spin: new Float32Array(count),
    swayRate: new Float32Array(count),
    phase: new Float32Array(count),
    hue: new Float32Array(count),
    alpha: new Float32Array(count),
    time: 0,
  };
  for (let i = 0; i < count; i++) {
    const rng = createRng(hash32(0x5ba9e + i * 0x9e3779b1));
    // Spread across the width in shuffled strata, so no two crowd together.
    s.x[i] = (i * 0.618034 + 0.3 * rng()) % 1;
    s.y[i] = rng() * 1080;
    s.half[i] = SIZE[0] + (SIZE[1] - SIZE[0]) * rng() ** 1.5;
    s.kind[i] = i % SHAPE_KINDS;
    // Bigger shapes are nearer and rise faster.
    const near = (s.half[i] - SIZE[0]) / (SIZE[1] - SIZE[0]);
    s.rise[i] = RISE[0] + (RISE[1] - RISE[0]) * (0.3 * rng() + 0.7 * near);
    s.spin[i] = (rng() * 2 - 1) * MAX_SPIN;
    s.swayRate[i] = (2 * Math.PI) / (SWAY_PERIOD[0] + (SWAY_PERIOD[1] - SWAY_PERIOD[0]) * rng());
    s.phase[i] = rng() * 2 * Math.PI;
    s.hue[i] = rng();
    s.alpha[i] = 0.3 + 0.25 * rng();
  }
  return s;
}

/**
 * Drifts the shapes up by `dt` seconds, each wrapping from just above the
 * frame to just below it.
 */
export function stepShapes(s: Shapes, dt: number): void {
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  s.time += d;
  const span = 1080 + 2 * SHAPE_MARGIN;
  for (let i = 0; i < s.y.length; i++) {
    s.y[i] = wrap(s.y[i] - s.rise[i] * d, -SHAPE_MARGIN, span);
  }
}

/** Shape `i`'s sideways sway (reference px) at the shapes' current time. */
export const shapeSway = (s: Shapes, i: number) =>
  SWAY * Math.sin(s.time * s.swayRate[i] + s.phase[i]);

/** Shape `i`'s angle (radians) at the shapes' current time. */
export const shapeAngle = (s: Shapes, i: number) => s.phase[i] + s.time * s.spin[i];
