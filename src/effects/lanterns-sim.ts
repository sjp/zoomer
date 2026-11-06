/**
 * Paper lanterns' simulation and shapes, kept free of GL so they can be tested:
 * the rounded-trapezoid body outline, the flame flicker curve, the lake
 * reflection transform, and the lanterns themselves rising, swaying and drifting
 * on a shared wind. Positions are in reference units (1 = one pixel of a
 * 1080-tall frame), y down.
 */
import type { Rgb } from "./color";
import { fanStrip } from "./leaves-sim";
import { approach, clamp, wrap } from "./math";
import { createRng } from "./noise";

/** Reference rise speed in px/s at 1080p for the nearest lanterns at a rise of 1. */
export const RISE_PX = 38;
/** Reference horizontal drift in px/s at 1080p for the nearest lanterns at a wind of 1. */
export const WIND_PX = 45;
/** Reference sway amplitude in px at 1080p for the nearest lanterns. */
export const SWAY_PX = 16;
/** Most sway tilt, in radians (about 4.6 degrees). */
export const TILT = 0.08;
/** Extra lean into the wind at a wind of ±1, in radians. */
export const WIND_LEAN = 0.07;
/** Most the flame dims at a flicker of 1: a few percent. */
export const FLICKER_DEPTH = 0.07;
/** Fastest flicker component, in Hz: well under the 2 Hz cap. */
export const FLICKER_MAX_HZ = 1.6;
/** Seconds a lantern takes to fade in or out when the count changes. */
export const FADE_TIME = 1.5;
/** Halo radius relative to the lantern's half-width. */
export const HALO_RADIUS = 3.2;
/** Lanterns nearer than this depth draw a halo; fainter far ones skip it. */
export const HALO_MIN_DEPTH = 0.2;
/** Half-height of the body outline in corner units (the top half-width is about 1). */
export const BODY_HALF_HEIGHT = 1.3;
/** Floats per lantern instance: x, y, half-width, opacity; r, g, b, halo; angle, flip. */
export const LANTERN_FLOATS = 10;
const TAU = Math.PI * 2;

// --- Shape ------------------------------------------------------------------

/**
 * Closed outline of the lantern body in corner units, y down: a trapezoid wider
 * at the top (half-width about 1) than at the bottom, with rounded corners. It is
 * the inner trapezoid grown by a circle (a Minkowski sum), so it stays convex.
 */
export function lanternOutline(): number[] {
  const round = 0.2;
  const inner = [
    [-0.8, -BODY_HALF_HEIGHT + round],
    [0.8, -BODY_HALF_HEIGHT + round],
    [0.52, BODY_HALF_HEIGHT - round],
    [-0.52, BODY_HALF_HEIGHT - round],
  ];
  const n = inner.length;
  /** Outward normal angle of the edge from vertex `i` to `i + 1` (the polygon is clockwise on screen). */
  const normal = (i: number) => {
    const [ax, ay] = inner[i];
    const [bx, by] = inner[(i + 1) % n];
    return Math.atan2(-(bx - ax), by - ay);
  };
  const out: number[] = [];
  const steps = 6;
  for (let i = 0; i < n; i++) {
    let a0 = normal((i + n - 1) % n);
    const a1 = normal(i);
    while (a0 > a1) {
      a0 -= TAU;
    }
    for (let s = 0; s <= steps; s++) {
      const a = a0 + ((a1 - a0) * s) / steps;
      out.push(inner[i][0] + Math.cos(a) * round, inner[i][1] + Math.sin(a) * round);
    }
  }
  return out;
}

/** Body triangle strip: a fan whose centre is the only corner at the origin. */
export const BODY_STRIP: readonly number[] = fanStrip(lanternOutline());

// --- Flicker and reflection ---------------------------------------------------

/**
 * Flame brightness multiplier at time `t` (seconds) for a lantern with phase
 * `phase` and rate `rate` in [0, 1]: two slow sines (0.35–0.75 Hz and
 * 0.9–1.6 Hz), so it never flashes. In `[1 - amount * FLICKER_DEPTH, 1]`.
 */
export function flicker(t: number, phase: number, rate: number, amount: number): number {
  const w1 = TAU * (0.35 + 0.4 * rate);
  const w2 = TAU * (0.9 + (FLICKER_MAX_HZ - 0.9) * rate);
  const s = 0.6 * Math.sin(w1 * t + phase) + 0.4 * Math.sin(w2 * t + phase * 2.3);
  return 1 - clamp(amount, 0, 1) * FLICKER_DEPTH * (0.5 + 0.5 * s);
}

/** Mirrors a y coordinate about the horizon at `horizon` (same units). Its own inverse. */
export function reflectY(y: number, horizon: number): number {
  return 2 * horizon - y;
}

// --- Lanterns -----------------------------------------------------------------

/** Lantern size relative to the nearest, by depth (0 far, 1 near). */
export const depthScale = (d: number) => 0.2 + 0.8 * d ** 1.3;
/** Rise and wind pace relative to the nearest, by depth. */
export const depthPace = (d: number) => 0.3 + 0.7 * d;
/** How far a lantern's colour fades towards the sky behind it, by depth. */
export const depthHaze = (d: number) => 0.65 * (1 - d) ** 2;
/** Brightness by depth. */
export const depthBright = (d: number) => 0.5 + 0.5 * d;

export interface LanternFrame {
  /** Screen width in reference px. */
  refWidth: number;
  /** Device px per reference px. */
  scale: number;
  /** Lanterns to show, 0..max. */
  count: number;
  /** Nearest lantern height in reference px. */
  size: number;
  rise: number;
  /** -1..1. */
  wind: number;
  /** 0..1. */
  flicker: number;
  /** Where lanterns respawn and the sky ends, in reference px from the top: 1080, or the lake horizon. */
  bottom: number;
  lanternColor: Rgb;
  skyTop: Rgb;
  skyBottom: Rgb;
}

export interface Lanterns {
  readonly max: number;
  /** Depth per lantern, 0 (far) to 1 (near): sorted ascending and never changed. */
  readonly depth: Float32Array;
  /** Positions in reference px, y down. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** After `step`: instances written before the first that draws a halo. */
  readonly haloFirst: number;
  /** Scales x positions after the width changes by `k`. */
  rescaleX: (k: number) => void;
  /**
   * Advances `dt` seconds and writes the visible lanterns far to near into
   * `data` (LANTERN_FLOATS at `stride` floats apart, in device px). Returns how many.
   */
  step: (dt: number, f: LanternFrame, data: Float32Array, stride: number) => number;
}

/** Reference px a lantern of depth `d` reaches beyond its centre, halo included. */
export function lanternReach(d: number, size: number): number {
  return (size / (2 * BODY_HALF_HEIGHT)) * depthScale(d) * HALO_RADIUS * 1.1;
}

export function createLanterns(max: number, refWidth: number, seed = 4141): Lanterns {
  const rand = createRng(seed);
  // Depths skew far, so the field reads as deep; sorted once for painter's order.
  const depths: number[] = [];
  for (let i = 0; i < max; i++) {
    depths.push(rand() ** 1.4);
  }
  depths.sort((a, b) => a - b);
  const depth = Float32Array.from(depths);
  const x = new Float64Array(max);
  const y = new Float64Array(max);
  const swayPhase = new Float64Array(max);
  const swayRate = new Float64Array(max);
  const flickPhase = new Float64Array(max);
  const flickRate = new Float64Array(max);
  const drift = new Float64Array(max);
  const fade = new Float64Array(max);
  /** Tint multipliers per lantern (r, g, b) around the base colour. */
  const tint = new Float32Array(max * 3);
  /**
   * A random rank per lantern: those ranked below the count show, so any count
   * picks lanterns spread over every depth while the draw order stays sorted.
   */
  const rank = new Uint16Array(max);
  for (let i = 0; i < max; i++) {
    rank[i] = i;
  }
  for (let i = max - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = rank[i];
    rank[i] = rank[j];
    rank[j] = t;
  }
  for (let i = 0; i < max; i++) {
    x[i] = rand() * refWidth;
    y[i] = rand() * 1080;
    swayPhase[i] = rand() * TAU;
    swayRate[i] = TAU * (0.06 + 0.07 * rand());
    flickPhase[i] = rand() * TAU;
    flickRate[i] = rand();
    drift[i] = (rand() - 0.5) * 6;
    const u = rand();
    // Mostly warm orange to gold, a few pinker or redder.
    if (u < 0.12) {
      tint.set([1, 0.72, 0.95], i * 3);
    } else if (u < 0.22) {
      tint.set([1, 0.78, 0.7], i * 3);
    } else {
      const t = rand() * 2 - 1;
      tint.set([1, 1 + 0.16 * t, 1 + 0.3 * t], i * 3);
    }
  }

  let time = 0;
  let haloFirst = 0;
  return {
    max,
    depth,
    x,
    y,
    get haloFirst() {
      return haloFirst;
    },
    rescaleX(k) {
      for (let i = 0; i < max; i++) {
        x[i] *= k;
      }
    },
    step(dt, f, data, stride) {
      time += dt;
      const { scale, size, refWidth: w, bottom } = f;
      const rise = Math.max(0, f.rise) * RISE_PX;
      const wind = clamp(f.wind, -1, 1);
      const fadeStep = dt / FADE_TIME;
      const halfWidth = size / (2 * BODY_HALF_HEIGHT);
      const [lr, lg, lb] = f.lanternColor;
      const [tr, tg, tb] = f.skyTop;
      const [br, bg, bb] = f.skyBottom;
      let n = 0;
      haloFirst = 0;
      for (let i = 0; i < max; i++) {
        const d = depth[i];
        const pace = depthPace(d);
        const reach = lanternReach(d, size);
        // Rise; a lantern fully off the top respawns below the bottom line at a new x.
        let yi = y[i] - rise * pace * dt;
        if (yi < -reach) {
          yi += bottom + 2 * reach;
          x[i] = rand() * w;
        }
        y[i] = yi;
        // Drift on the shared wind, wrapping once fully off either side.
        x[i] = wrap(x[i] + (wind * WIND_PX + drift[i]) * pace * dt, -reach, w + 2 * reach);

        fade[i] = approach(fade[i], rank[i] < f.count ? 1 : 0, fadeStep);
        if (fade[i] <= 0) {
          continue;
        }

        const s = depthScale(d);
        const sway = Math.sin(swayRate[i] * time + swayPhase[i]);
        const o = n * stride;
        data[o] = (x[i] + SWAY_PX * s * sway) * scale;
        data[o + 1] = yi * scale;
        data[o + 2] = halfWidth * s * scale;
        data[o + 3] = fade[i];
        // Colour: tinted base, dimmed by depth and the flame, then hazed towards the sky behind.
        const k = depthBright(d) * flicker(time, flickPhase[i], flickRate[i], f.flicker);
        const h = depthHaze(d);
        const v = clamp(yi / bottom, 0, 1);
        const t3 = i * 3;
        data[o + 4] = (1 - h) * Math.min(1, lr * tint[t3]) * k + h * (tr + (br - tr) * v);
        data[o + 5] = (1 - h) * Math.min(1, lg * tint[t3 + 1]) * k + h * (tg + (bg - tg) * v);
        data[o + 6] = (1 - h) * Math.min(1, lb * tint[t3 + 2]) * k + h * (tb + (bb - tb) * v);
        data[o + 7] = d < HALO_MIN_DEPTH ? 0 : 0.25 + 0.35 * d;
        // Tilt leads the sway (it leans the way it is moving) and into the wind.
        data[o + 8] = TILT * Math.cos(swayRate[i] * time + swayPhase[i]) + WIND_LEAN * wind;
        data[o + 9] = 1;
        if (d < HALO_MIN_DEPTH) {
          haloFirst = n + 1;
        }
        n++;
      }
      return n;
    },
  };
}
