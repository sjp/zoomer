/**
 * Candlelight model: where the candles stand, how their flames sway and flicker,
 * and how much light they throw on the wall and table. Pure JS, no GL, so it can
 * be unit-tested.
 *
 * Coordinates are reference px (a 1080px-tall frame), origin at the bottom-left,
 * y up (as `gl_FragCoord`).
 */
import { clamp, smoothstep } from "../math";
import { createRng, type Noise } from "../noise";
import { LAYOUT_OPTIONS, MAX_CANDLES } from "./candlelight.meta";

export const REF_HEIGHT = 1080;
/** Where the table top meets the wall, reference px from the bottom. */
export const SURFACE_Y = 240;

/** Candle half-widths (reference px) before slot limits. */
const HALF_W_MIN = 24;
const HALF_W_MAX = 44;
/** Tallest candle, reference px. */
export const MAX_HEIGHT = 300;
/** Shortest candle as a fraction of `MAX_HEIGHT` (in a cluster). */
const HEIGHT_MIN = 0.32;
/** Frame margin and gap to the centre third, as fractions of the frame width. */
const MARGIN_FRAC = 0.035;
const GAP_FRAC = 0.02;
/** Width per candle of a corner cluster, reference px. */
const CLUSTER_SLOT = 115;
/** Largest candle half-width as a fraction of its slot; the rest is a gap. */
const SLOT_FILL = 0.4;
/** Largest sideways jitter of a candle in its slot, as a fraction of the slot. */
const SLOT_JITTER = 0.05;
/** Base heights (y of the candle's bottom) of cluster candles: back and front rows. */
const BACK_BASE_Y = 208;
const FRONT_BASE_Y = 162;
const ROW_BASE_Y = 186;

/** Wick height, reference px. The flame starts `FLAME_START` of the way up it. */
export const WICK = 7;
export const FLAME_START = 0.35;
/** Flame half-width and length at rest, reference px. */
export const FLAME_W = 7.5;
export const FLAME_L = 36;
/** The flame's light sits this fraction of the way up the flame. */
export const FLAME_CENTRE = 0.4;

/** Candle positions and sizes, `count` used of `MAX_CANDLES` slots. */
export interface CandleLayout {
  count: number;
  refWidth: number;
  /** Centre x. */
  x: Float64Array;
  /** y of the candle's bottom edge (front of the base ellipse's centre). */
  baseY: Float64Array;
  halfW: Float64Array;
  height: Float64Array;
  /** 0..1, varies the melted rim. */
  seed: Float64Array;
}

export function createCandleLayout(): CandleLayout {
  return {
    count: 0,
    refWidth: 1920,
    x: new Float64Array(MAX_CANDLES),
    baseY: new Float64Array(MAX_CANDLES),
    halfW: new Float64Array(MAX_CANDLES),
    height: new Float64Array(MAX_CANDLES),
    seed: new Float64Array(MAX_CANDLES),
  };
}

/** Light position of candle `i`'s flame. */
export function flameBaseY(l: CandleLayout, i: number): number {
  return l.baseY[i] + l.height[i] + WICK * FLAME_START;
}
export function lightY(l: CandleLayout, i: number): number {
  return flameBaseY(l, i) + FLAME_L * FLAME_CENTRE;
}

/**
 * Places `n` candles from index `first` in `[a, b]`, one per equal slot, so they
 * never touch: each is at most `SLOT_FILL` of its slot either side of a centre
 * jittered by at most `SLOT_JITTER`.
 */
function placeRun(
  l: CandleLayout,
  first: number,
  n: number,
  a: number,
  b: number,
  row: boolean,
  rng: () => number,
): void {
  const slot = (b - a) / n;
  for (let k = 0; k < n; k++) {
    const i = first + k;
    l.x[i] = a + (k + 0.5) * slot + (rng() - 0.5) * 2 * SLOT_JITTER * slot;
    const hw = row
      ? HALF_W_MIN + (HALF_W_MAX - HALF_W_MIN) * (0.4 + 0.2 * rng())
      : HALF_W_MIN + (HALF_W_MAX - HALF_W_MIN) * rng();
    l.halfW[i] = Math.min(hw, slot * SLOT_FILL);
    const h = row ? 0.48 + 0.14 * rng() : HEIGHT_MIN + (1 - HEIGHT_MIN) * rng();
    l.height[i] = Math.max(MAX_HEIGHT * h, l.halfW[i] * 1.5);
    l.baseY[i] = row ? ROW_BASE_Y : (k % 2 === 0 ? FRONT_BASE_Y : BACK_BASE_Y) + (rng() - 0.5) * 12;
    l.seed[i] = rng();
  }
}

/**
 * Lays out `count` candles (clamped to 1..`MAX_CANDLES`) for a frame `refWidth`
 * reference px wide, keeping them inside the outer thirds: "left" and "right"
 * group them in one bottom corner, "both" splits them between the corners, and
 * "row" spreads evenly-sized candles across both outer thirds. Deterministic for
 * a given layout, count and width.
 */
export function layoutCandles(
  l: CandleLayout,
  layout: string,
  count: number,
  refWidth: number,
): CandleLayout {
  const n = clamp(Math.round(count), 1, MAX_CANDLES);
  const w = Math.max(1, refWidth);
  const index = Math.max(
    0,
    LAYOUT_OPTIONS.findIndex((o) => o.value === layout),
  );
  const id = LAYOUT_OPTIONS[index].value;
  const rng = createRng(0x5eed + index * 977 + n * 131);
  l.count = n;
  l.refWidth = w;
  const margin = w * MARGIN_FRAC;
  const gap = w * GAP_FRAC;
  const leftA = margin;
  const leftB = Math.max(leftA + 1, w / 3 - gap);
  const rightB = w - margin;
  const rightA = Math.min(rightB - 1, (2 * w) / 3 + gap);
  const row = id === "row";
  /** A run anchored at the outer edge, as wide as `k` cluster slots at most. */
  const leftRun = (first: number, k: number) => {
    const b = row ? leftB : Math.min(leftB, leftA + k * CLUSTER_SLOT);
    placeRun(l, first, k, leftA, b, row, rng);
  };
  const rightRun = (first: number, k: number) => {
    const a = row ? rightA : Math.max(rightA, rightB - k * CLUSTER_SLOT);
    placeRun(l, first, k, a, rightB, row, rng);
  };
  if (id === "left") {
    leftRun(0, n);
  } else if (id === "right") {
    rightRun(0, n);
  } else {
    const nLeft = Math.floor(n / 2);
    if (nLeft > 0) {
      leftRun(0, nLeft);
    }
    rightRun(nLeft, n - nLeft);
  }
  return l;
}

/** Per-candle flame motion, written by `flameAt`. */
export interface FlameMotion {
  /** Lean of the flame's tip, radians (positive leans right). */
  sway: Float64Array;
  /** Length multiplier. */
  stretch: Float64Array;
  /** Brightness multiplier, a few percent either side of 1. */
  bright: Float64Array;
}

export function createFlameMotion(): FlameMotion {
  return {
    sway: new Float64Array(MAX_CANDLES),
    stretch: new Float64Array(MAX_CANDLES),
    bright: new Float64Array(MAX_CANDLES),
  };
}

/** Sway at rest, radians, at a flicker of 1 (half at 0). */
export const SWAY_BASE = 0.07;
/** Extra lean in a full draft, radians. */
export const LEAN_MAX = 0.32;
/** Brightness flicker amplitude at a flicker of 1. */
export const FLICKER_AMP = 0.05;
const STRETCH_AMP = 0.07;
const LEAN_STRETCH = 0.12;
const LEAN_DIM = 0.04;
/**
 * Noise rates (noise units per second). Simplex noise has little energy above
 * about one cycle per unit, so these keep every curve well below 2 Hz.
 */
const RATE_SWAY = [0.35, 0.9] as const;
const RATE_BRIGHT = [0.6, 1.3] as const;
const RATE_STRETCH = 0.5;
const RATE_GUST = 0.09;
const RATE_DIR = 0.04;
/** Largest |brightness - 1| `flameAt` can produce. */
export const BRIGHT_RANGE = FLICKER_AMP + LEAN_DIM;
/** Largest |sway| `flameAt` can produce. */
export const SWAY_RANGE = SWAY_BASE + LEAN_MAX;

/**
 * The shared draft at time `t` (seconds): 0 when still, up to ±1 while a breath
 * of air leans every flame the same way. `draft` (0..1) sets how often. Smooth
 * in `t` and in `draft`.
 */
export function draftAt(noise: Noise, t: number, draft: number): number {
  if (!(draft > 0)) {
    return 0;
  }
  const th = 0.7 - 0.8 * Math.min(1, draft);
  const gust = smoothstep(th, th + 0.3, noise.noise2(t * RATE_GUST, 101.7));
  const dir = clamp(noise.noise2(t * RATE_DIR, 203.3) * 2.5, -1, 1);
  return gust * dir;
}

/**
 * Flame `i`'s sway, stretch and brightness at time `t` (seconds) into `out`.
 * `flicker` (0..1) scales the flicker; `lean` (-1..1) is the shared draft.
 * Stateless, so continuous in `t`.
 */
export function flameAt(
  noise: Noise,
  i: number,
  t: number,
  flicker: number,
  lean: number,
  out: FlameMotion,
): void {
  const f = clamp(flicker, 0, 1);
  const l = clamp(lean, -1, 1);
  const k = i * 7.13 + 0.5;
  const sway =
    noise.noise2(t * RATE_SWAY[0], k) * 0.7 + noise.noise2(t * RATE_SWAY[1], k + 3.3) * 0.3;
  out.sway[i] = SWAY_BASE * (0.5 + 0.5 * f) * clamp(sway, -1, 1) + LEAN_MAX * l;
  const b =
    noise.noise2(t * RATE_BRIGHT[0], k + 11.1) * 0.65 +
    noise.noise2(t * RATE_BRIGHT[1], k + 19.7) * 0.35;
  out.bright[i] = 1 + FLICKER_AMP * f * clamp(b, -1, 1) - LEAN_DIM * Math.abs(l);
  const s = noise.noise2(t * RATE_STRETCH, k + 31.9);
  out.stretch[i] = 1 + STRETCH_AMP * f * clamp(s, -1, 1) + LEAN_STRETCH * Math.abs(l);
}

/** Wall-light falloff radius, reference px. */
export const LIGHT_R = 240;
/** The table is seen at a grazing angle, so its light pools are flattened by this. */
export const SURF_SQUASH = 2.5;
/** Table light relative to wall light. */
export const SURF_GAIN = 0.85;
/** Peak light sum, after `lightGain`, at a brightness of 1. */
export const TARGET_PEAK = 2;
/** Unlit fraction of the wall and table colour. */
export const AMBIENT = 0.16;
/** Colour of the candlelight on the wall. */
export const LIGHT_TINT = [1, 0.64, 0.34] as const;

/** One flame's light at offset (dx, dy): a soft inverse-square-like falloff. */
export function falloff(dx: number, dy: number): number {
  const q = 1 + (dx * dx + dy * dy) / (LIGHT_R * LIGHT_R);
  return 1 / (q * q);
}

/** Light on the wall at (x, y), every flame at brightness 1. */
export function wallLightAt(l: CandleLayout, x: number, y: number): number {
  let sum = 0;
  for (let i = 0; i < l.count; i++) {
    sum += falloff(x - l.x[i], y - lightY(l, i));
  }
  return sum;
}

/** Light on the table at (x, y), every flame at brightness 1 (before `SURF_GAIN`). */
export function surfaceLightAt(l: CandleLayout, x: number, y: number): number {
  let sum = 0;
  for (let i = 0; i < l.count; i++) {
    sum += falloff(x - l.x[i], (y - l.baseY[i]) * SURF_SQUASH);
  }
  return sum;
}

/** Light at (x, y) as the lighting pass picks it: wall above `SURFACE_Y`, table below. */
export function lightAt(l: CandleLayout, x: number, y: number): number {
  return y >= SURFACE_Y ? wallLightAt(l, x, y) : surfaceLightAt(l, x, y) * SURF_GAIN;
}

/** Largest `lightAt` over a `step`-px grid and at every flame and candle base. */
export function peakLight(l: CandleLayout, step = 16): number {
  let peak = 0;
  for (let y = 0; y <= REF_HEIGHT; y += step) {
    for (let x = 0; x <= l.refWidth; x += step) {
      peak = Math.max(peak, lightAt(l, x, y));
    }
  }
  for (let i = 0; i < l.count; i++) {
    peak = Math.max(peak, lightAt(l, l.x[i], lightY(l, i)), lightAt(l, l.x[i], l.baseY[i]));
  }
  return peak;
}

/** Gain that brings the layout's peak light to `TARGET_PEAK`, whatever the count. */
export function lightGain(l: CandleLayout): number {
  const peak = peakLight(l);
  return peak > 0 ? TARGET_PEAK / peak : 0;
}
