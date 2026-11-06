/**
 * Pure logic for the Mandelbrot Zoom effect, shared by `mandel.ts` and its tests:
 * the zoom targets, the looping zoom schedule, the view transform, the palette
 * mapping that keeps colours self-similar, a CPU reference of the smooth escape
 * count, and the palettes.
 *
 * **Looping.** Float32 runs out of precision a dozen or so doublings in, so the
 * zoom loops. Each target is a self-similar centre: zooming in by `2^loop` (and
 * turning by the matching angle) gives back almost the same picture, so a plain
 * cross-fade from the deep view to the shallow one is near-invisible.
 *
 * - Three targets are Misiurewicz points `c0`: the critical orbit lands on a
 *   repelling fixed point with multiplier `ρ`. Near `c0` the set is asymptotically
 *   self-similar: the picture around `c0 + δ` matches the one around `c0 + ρδ`,
 *   and escapes `periodIters` (here 1) iteration earlier. One "period" is a zoom
 *   by `|ρ|` and a turn by `arg ρ`. Where the spiral has two or three arms, the
 *   turn is taken modulo the arm symmetry (180° or 120°), so the arms hold still
 *   while zooming, and a loop is a whole number of arm cycles.
 * - The mini-brot target zooms from the whole set into the period-3 copy on the
 *   real axis, about the fixed point of the similarity that maps one to the
 *   other. Escape counts there are three times the whole set's (plus a constant),
 *   so its palette mapping scales as well as shifts.
 *
 * The shader never sees the zoom depth: it gets a complex scale-and-turn per
 * view, an offset, and the palette mapping, all built here in float64.
 */
import { hexToUnitRgb, type Rgb } from "./color";
import {
  DEFAULT_DETAIL,
  MAX_DETAIL,
  MAX_SECONDS_PER_DOUBLING,
  MIN_DETAIL,
  MIN_SECONDS_PER_DOUBLING,
  mandelMeta,
} from "./mandel.meta";
import { clamp, smoothstep, wrap } from "./math";
import { lookup } from "./lookup";

export const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;

export type TargetName = "seahorse" | "elephant" | "spiral" | "minibrot";
export type PaletteName = "ocean" | "fire" | "pastel" | "mono";

export interface MandelTarget {
  /** Zoom centre, float64. The shader gets it rounded to float32. */
  centre: readonly [number, number];
  /** Half the frame height, in the complex plane, at depth 0. */
  halfHeight: number;
  /** Doublings of zoom per period: log2 |ρ|. */
  periodDoublings: number;
  /** Turn of the view per period, radians (counter-clockwise). */
  periodTwist: number;
  /** Periods per loop. A multiple of the spiral's arm count. */
  periods: number;
  /**
   * Escape-count law per period: a point one period deeper escapes after
   * `gain * n + iters` iterations, where `n` is its shallow twin's count.
   */
  periodGain: number;
  periodIters: number;
  /** Typical smooth escape count at depth 0, for the iteration cap. */
  baseIters: number;
  /** Zoom focus relative to the frame centre, in half-heights (x right, y up). */
  focus: readonly [number, number];
  /** Escape iterations (at depth 0) per palette cycle. */
  cycle: number;
  /** Cross-fade length, in doublings. */
  fade: number;
  /** Preperiod of the critical orbit (Misiurewicz targets; 0 for the mini-brot). */
  preperiod: number;
}

/** Period-3 mini-brot on the real axis: its nucleus, and its size relative to the whole set. */
export const MINIBROT_NUCLEUS = -1.7548776662466927;
/** Maps the whole set's cusp (1/4) to the mini-brot's (-7/4): Φ(c) = nucleus + λc. */
export const MINIBROT_SCALE = (-1.75 - MINIBROT_NUCLEUS) / 0.25;
/** Fixed point of Φ: the one point that zooming in by 1/λ maps onto itself. */
const MINIBROT_FIXED = MINIBROT_NUCLEUS / (1 - MINIBROT_SCALE);
const MINIBROT_HALF_HEIGHT = 1.3;
/** Whole-set view centred on -0.75 at depth 0. */
const MINIBROT_VIEW_CENTRE = -0.75;

export const TARGETS: Readonly<Record<TargetName, MandelTarget>> = {
  // A double-armed spiral off the period-2 bulb, seahorse-valley style. Arms hold
  // still under a 180° turn, so the turn is arg ρ - 180° and loops are even.
  seahorse: {
    centre: [-0.8739318846956909, 0.2553828556640233],
    halfHeight: 0.006,
    periodDoublings: 0.21260092659746596,
    periodTwist: (180 - 168.0784354208917) * DEG,
    periods: 20,
    periodGain: 1,
    periodIters: 1,
    baseIters: 26,
    focus: [0, 0],
    cycle: 28,
    fade: 0.5,
    preperiod: 11,
  },
  // A trunk tip in elephant valley: a single spiral.
  elephant: {
    centre: [0.30075970022151555, 0.02015015982612481],
    halfHeight: 4e-4,
    periodDoublings: 0.23962851870342775,
    periodTwist: 22.88081873822297 * DEG,
    periods: 11,
    periodGain: 1,
    periodIters: 1,
    baseIters: 29,
    focus: [0, 0],
    cycle: 28,
    fade: 0.5,
    preperiod: 14,
  },
  // A three-armed spiral off the period-3 bulb. Arms repeat every 120°.
  spiral: {
    centre: [0.0005697777730442689, 0.7514647407619401],
    halfHeight: 0.005,
    periodDoublings: 0.17863509436662794,
    periodTwist: (120 - 113.04535689414764) * DEG,
    periods: 18,
    periodGain: 1,
    periodIters: 1,
    baseIters: 29,
    focus: [0, 0],
    cycle: 28,
    fade: 0.5,
    preperiod: 10,
  },
  // Whole set to its period-3 copy on the antenna.
  minibrot: {
    centre: [MINIBROT_FIXED, 0],
    halfHeight: MINIBROT_HALF_HEIGHT,
    periodDoublings: Math.log2(1 / MINIBROT_SCALE),
    periodTwist: 0,
    periods: 1,
    periodGain: 3,
    periodIters: 3,
    baseIters: 3,
    focus: [(MINIBROT_FIXED - MINIBROT_VIEW_CENTRE) / MINIBROT_HALF_HEIGHT, 0],
    cycle: 24,
    fade: 0.8,
    preperiod: 0,
  },
};

export const TARGET_NAMES: TargetName[] = ["seahorse", "elephant", "spiral", "minibrot"];

/** The target for a `target` select value; seahorse for an unknown value. */
export function targetFor(name: string): MandelTarget {
  return lookup(TARGETS, name, "seahorse");
}

/** Doublings of zoom in one loop. */
export function loopDoublings(t: MandelTarget): number {
  return t.periods * t.periodDoublings;
}

/**
 * Advances the loop position `u` (doublings into the loop) by `dt` seconds at
 * `secondsPerDoubling`, wrapped to [0, loop). Log-scale is linear in time, and
 * accumulating the rate keeps a speed change from jumping.
 */
export function advanceZoom(
  u: number,
  dt: number,
  secondsPerDoubling: number,
  loop: number,
): number {
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const s = Number.isFinite(secondsPerDoubling)
    ? clamp(secondsPerDoubling, MIN_SECONDS_PER_DOUBLING, MAX_SECONDS_PER_DOUBLING)
    : mandelMeta.params.speed.default;
  const v = Number.isFinite(u) ? u : 0;
  return wrap(v + d / s, 0, loop);
}

/**
 * Weight of the incoming view at loop position `u`: 0 until the last `fade`
 * doublings of the loop, then easing up to 1 at the loop point. The incoming view
 * sits one loop shallower (depth `u - loop`), so after the wrap it carries on as
 * the only view without a jump.
 */
export function fadeWeight(t: MandelTarget, u: number): number {
  const loop = loopDoublings(t);
  return smoothstep(loop - t.fade, loop, u);
}

/** Advances the user spin angle by `dt` s at `degPerSecond`, wrapped to [0, 2π). */
export function advanceSpin(angle: number, dt: number, degPerSecond: number): number {
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const v = Number.isFinite(degPerSecond) ? degPerSecond : 0;
  const a = Number.isFinite(angle) ? angle : 0;
  return wrap(a + d * v * DEG, 0, TAU);
}

/** Palette cycles per second of slow drift: one full cycle every four minutes. */
export const DRIFT_RATE = 1 / 240;

/** Advances the palette drift (in cycles) by `dt` s, wrapped to [0, 1). */
export function advanceDrift(drift: number, dt: number): number {
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const v = Number.isFinite(drift) ? drift : 0;
  return wrap(v + d * DRIFT_RATE, 0, 1);
}

/**
 * The view at `depth` doublings with the user spin `spin` (radians), as four
 * floats for the shader: a complex factor `w` (x, y) and offset (z, w). The point
 * shown at frame position `p` (in half-heights from the centre, y up) is
 * `centre + w·p + offset`. Writes `out[o..o+3]`.
 *
 * Z = halfHeight · 2^-depth · e^(i·twist·depth/periodDoublings) is the zoom with
 * its co-rotation; the spin turns the frame position about the frame centre, and
 * the focus offset is zoomed but not spun, so the focus stays a fixed point of the
 * self-similarity.
 */
export function writeView(
  t: MandelTarget,
  depth: number,
  spin: number,
  out: Float32Array | Float64Array,
  o = 0,
): void {
  const mag = t.halfHeight * 2 ** -depth;
  const ang = (t.periodTwist * depth) / t.periodDoublings;
  const zr = mag * Math.cos(ang);
  const zi = mag * Math.sin(ang);
  const cs = Math.cos(spin);
  const sn = Math.sin(spin);
  out[o] = zr * cs - zi * sn;
  out[o + 1] = zr * sn + zi * cs;
  const [fx, fy] = t.focus;
  out[o + 2] = -(zr * fx - zi * fy);
  out[o + 3] = -(zr * fy + zi * fx);
}

/** Escape-count offset after `q` periods: K(q) with K(0) = 0 and K(q+1) = gain·K(q) + iters. */
function itersOffset(t: MandelTarget, q: number): number {
  const g = t.periodGain;
  return g === 1 ? t.periodIters * q : (t.periodIters * (g ** q - 1)) / (g - 1);
}

/**
 * Maps a smooth escape count `nu` at `depth` to a depth-independent index
 * (escape iterations at depth 0): `idx = nu·scale + offset`. A point and its twin
 * one period deeper get the same index, so the colours zoom with the shapes.
 * Writes scale and offset to `out[o..o+1]`.
 */
export function writePaletteMap(
  t: MandelTarget,
  depth: number,
  out: Float32Array | Float64Array,
  o = 0,
): void {
  const q = depth / t.periodDoublings;
  const scale = t.periodGain ** -q;
  out[o] = scale;
  out[o + 1] = -itersOffset(t, q) * scale;
}

/**
 * Iteration cap in index units (see `writePaletteMap`), the same at every depth,
 * so the cap zooms with the picture. The deepest view of the loop gets `detail`
 * iterations above its typical escape count. Shallower views get the same
 * headroom on a Misiurewicz target, and a third of it per period on the mini-brot,
 * whose escape counts triple per period.
 */
export function capIndex(t: MandelTarget, detail: number): number {
  const d = Number.isFinite(detail) ? clamp(detail, MIN_DETAIL, MAX_DETAIL) : DEFAULT_DETAIL;
  return t.baseIters + d * t.periodGain ** -t.periods;
}

/** Iteration cap at `depth`: the escape count whose index is `capIndex`. */
export function iterCap(t: MandelTarget, depth: number, detail: number): number {
  const q = depth / t.periodDoublings;
  return capIndex(t, detail) * t.periodGain ** q + itersOffset(t, q);
}

/** Squared escape radius; large, so the smooth count is accurate. */
export const ESCAPE_R2 = 256;

/**
 * True for points in the main cardioid or the period-2 bulb, which the shader
 * skips without iterating.
 */
export function inMainBulbs(cr: number, ci: number): boolean {
  const x = cr - 0.25;
  const q = x * x + ci * ci;
  if (q * (q + x) <= 0.25 * ci * ci) {
    return true;
  }
  return (cr + 1) * (cr + 1) + ci * ci <= 0.0625;
}

/**
 * CPU reference of the shader's smooth escape count: `i + 1 - log2(log2|z_i|)`
 * for the first `z_i` outside the escape radius, Infinity if none of
 * `z_0..z_{maxIter-1}` escapes. Continuous across escape bands: one more
 * iteration squares |z|, which doubles log2|z| and adds 1 to `i`.
 */
export function smoothIter(cr: number, ci: number, maxIter: number): number {
  if (inMainBulbs(cr, ci)) {
    return Infinity;
  }
  let zr = 0;
  let zi = 0;
  for (let i = 0; i < maxIter; i++) {
    const x2 = zr * zr;
    const y2 = zi * zi;
    const r2 = x2 + y2;
    if (r2 > ESCAPE_R2) {
      return i + 1 - Math.log2(0.5 * Math.log2(r2));
    }
    zi = 2 * zr * zi + ci;
    zr = x2 - y2 + cr;
  }
  return Infinity;
}

/**
 * Multiplier of the cycle a Misiurewicz target's critical orbit lands on, after
 * `preperiod` steps (period 1), as [|ρ|, arg ρ]. For checking the table.
 */
export function landingMultiplier(t: MandelTarget): [number, number] {
  const [cr, ci] = t.centre;
  let zr = 0;
  let zi = 0;
  for (let k = 0; k < t.preperiod; k++) {
    const x = zr * zr - zi * zi + cr;
    zi = 2 * zr * zi + ci;
    zr = x;
  }
  return [Math.hypot(2 * zr, 2 * zi), Math.atan2(2 * zi, 2 * zr)];
}

// ---------------------------------------------------------------------------
// Palettes

export interface Palette {
  /** Cyclic colour stops, evenly spaced. */
  stops: readonly string[];
  /** Colour inside the set, and where the iteration cap is near. */
  interior: string;
}

/** Kept moderate: the brightest stop is the only light one, and brief. */
export const PALETTES: Readonly<Record<PaletteName, Palette>> = {
  ocean: {
    stops: ["#0a1a33", "#123f66", "#1f7891", "#7fc3c2", "#2a5f8f", "#132c55"],
    interior: "#03060d",
  },
  fire: {
    stops: ["#1c070d", "#5c1618", "#a8401f", "#e39a4a", "#8c3019", "#3a0e12"],
    interior: "#070203",
  },
  pastel: {
    stops: ["#b98fa8", "#9187bd", "#79a6bd", "#8fb89a", "#c4ae86", "#b9919a"],
    interior: "#16141d",
  },
  mono: {
    stops: ["#0e1117", "#2a303c", "#626b7d", "#a7afbf", "#4e5666", "#1e232c"],
    interior: "#05060a",
  },
};

export const PALETTE_NAMES: PaletteName[] = ["ocean", "fire", "pastel", "mono"];

/** The palette for a `palette` select value; ocean for an unknown value. */
export function paletteFor(name: string): Palette {
  return lookup(PALETTES, name, "ocean");
}

/** Width of the palette lookup texture. */
export const PALETTE_SIZE = 256;

/** Palette colour at `u` cycles (wraps), interpolated between stops, 0..1 channels. */
export function paletteAt(p: Palette, u: number): Rgb {
  const n = p.stops.length;
  const x = wrap(u, 0, 1) * n;
  const i = Math.floor(x) % n;
  const f = x - Math.floor(x);
  const a = hexToUnitRgb(p.stops[i]);
  const b = hexToUnitRgb(p.stops[(i + 1) % n]);
  // Smoothstep between stops: no kinks at the stops, so no visible ridges.
  const s = f * f * (3 - 2 * f);
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
}

/** RGBA8 texels for the palette lookup texture (`PALETTE_SIZE` wide, one row, repeating). */
export function paletteTexels(p: Palette): Uint8Array {
  const out = new Uint8Array(PALETTE_SIZE * 4);
  for (let k = 0; k < PALETTE_SIZE; k++) {
    // Texel centres, so the texture's repeat filtering matches `paletteAt`.
    const c = paletteAt(p, (k + 0.5) / PALETTE_SIZE);
    out[4 * k] = Math.round(c[0] * 255);
    out[4 * k + 1] = Math.round(c[1] * 255);
    out[4 * k + 2] = Math.round(c[2] * 255);
    out[4 * k + 3] = 255;
  }
  return out;
}

/** Mean colour of a palette: what a band too fine for the pixels averages to. */
export function paletteMean(p: Palette): Rgb {
  const n = 64;
  const m: Rgb = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    const c = paletteAt(p, k / n);
    m[0] += c[0] / n;
    m[1] += c[1] / n;
    m[2] += c[2] / n;
  }
  return m;
}
