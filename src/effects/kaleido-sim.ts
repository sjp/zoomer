/**
 * Pure model for the Kaleidoscope effect: the mirror fold that maps any point of
 * the view into the fundamental wedge, the layout of the wedge's source texture,
 * the palettes, and the glass chips that drift and tumble inside the wedge.
 *
 * Units: the view's radius is 1. The wedge is the sector 0 <= angle <= w,
 * radius <= 1, with its apex at the origin; w = 2 pi / segments.
 */
import { hexToUnitRgb, type Rgb } from "./color";
import { createRng } from "./noise";
import { lookup } from "./lookup";

export const TAU = Math.PI * 2;

export const SEGMENTS = [6, 8, 12] as const;
const DEFAULT_SEGMENTS = 8;

/** Mirrored segments for a `segments` option value; 8 for anything unknown. */
export function segmentCount(name: string): number {
  const n = Number(name);
  return (SEGMENTS as readonly number[]).includes(n) ? n : DEFAULT_SEGMENTS;
}

/** The wedge angle for `segments` mirrored segments (always even, so mirrors pair up). */
export function wedgeAngle(segments: number): number {
  return TAU / segments;
}

/**
 * Folds an angle (radians, any value) into [0, w]: reduce modulo 2w, the period
 * of a mirror pair, then reflect the second half back across the mirror at w.
 * Continuous everywhere, and the identity on [0, w]. The composite shader uses
 * the same formula.
 */
export function foldAngle(a: number, w: number): number {
  const p = 2 * w;
  const m = a - p * Math.floor(a / p);
  return w - Math.abs(m - w);
}

/**
 * Folds the point (x, y) into the wedge of angle `w`, writing it to `out`
 * (radius unchanged). Returns `out`.
 */
export function foldPoint(x: number, y: number, w: number, out: [number, number]) {
  const r = Math.hypot(x, y);
  const a = r > 0 ? foldAngle(Math.atan2(y, x), w) : 0;
  out[0] = r * Math.cos(a);
  out[1] = r * Math.sin(a);
  return out;
}

/** Distances from (x, y) to the wedge's two mirrors and its rim; all >= 0 inside. */
export function wedgeDistances(x: number, y: number, w: number) {
  return {
    first: y,
    second: x * Math.sin(w) - y * Math.cos(w),
    rim: 1 - Math.hypot(x, y),
  };
}

/** Margin around the wedge in the source texture, in view radii. */
export const SOURCE_MARGIN = 0.02;

export interface SourceLayout {
  /** Texture size in texels. */
  width: number;
  height: number;
  /** Wedge-space point at the texture's (0, 0) corner. */
  originX: number;
  originY: number;
  /** Wedge-space extent the texture covers; uv = (q - origin) / span. */
  spanX: number;
  spanY: number;
}

/**
 * The source texture's footprint: the wedge's bounding box plus a margin, at
 * `radiusPx` texels per unit (matched to the output, so it stays crisp; the fold
 * is a rigid motion piecewise, so one texel lands on one pixel everywhere),
 * scaled down only to fit `maxSize`.
 */
export function sourceLayout(w: number, radiusPx: number, maxSize: number): SourceLayout {
  const spanX = 1 + 2 * SOURCE_MARGIN;
  const spanY = Math.sin(Math.min(w, Math.PI / 2)) + 2 * SOURCE_MARGIN;
  const r = Math.max(1, radiusPx);
  const fit = Math.min(1, maxSize / Math.ceil(spanX * r));
  return {
    width: Math.max(1, Math.min(maxSize, Math.ceil(spanX * r * fit))),
    height: Math.max(1, Math.min(maxSize, Math.ceil(spanY * r * fit))),
    originX: -SOURCE_MARGIN,
    originY: -SOURCE_MARGIN,
    spanX,
    spanY,
  };
}

export type PaletteName = "jewel" | "pastel" | "mono";
export type ViewName = "full" | "circle";

export interface KaleidoPalette {
  /** Backlight showing between chips. */
  bg: string;
  /** Circle view: the dark surround outside the eyepiece. */
  surround: string;
  /** Glass colours. */
  chips: readonly string[];
  /** Scales every chip's opacity, so light palettes don't wash out where chips overlap. */
  opacity: number;
}

export const PALETTES: Record<PaletteName, KaleidoPalette> = {
  jewel: {
    bg: "#08070f",
    surround: "#020203",
    chips: ["#b3123a", "#1f4fbf", "#118a5a", "#7b2fa8", "#d89a1c", "#0f8a96", "#c9541a"],
    opacity: 1,
  },
  pastel: {
    bg: "#24212f",
    surround: "#0c0b10",
    chips: ["#f0a3b5", "#a3c3f0", "#b2e0bf", "#f2d9a2", "#c9b0ec", "#a5dde0"],
    opacity: 0.6,
  },
  mono: {
    bg: "#0c0e10",
    surround: "#030304",
    chips: ["#8a96a3", "#6c7783", "#b0b8c0", "#56606a", "#98a2ac"],
    opacity: 0.7,
  },
};

export function palette(name: string): KaleidoPalette {
  return lookup(PALETTES, name, "jewel");
}

export function isCircleView(name: string): boolean {
  return name === "circle";
}

export interface PaletteData {
  bg: Rgb;
  surround: Rgb;
  chips: readonly Rgb[];
  opacity: number;
  /** A flat mid colour the contrast control pulls towards. */
  mean: Rgb;
}

/** Share of the view chips cover on average, for the mean colour. */
const MEAN_COVERAGE = 0.6;
const DATA = new Map<KaleidoPalette, PaletteData>();

/** Parsed palette colours, built once per palette. */
export function paletteData(name: string): PaletteData {
  const p = palette(name);
  let d = DATA.get(p);
  if (!d) {
    const bg = hexToUnitRgb(p.bg);
    const chips = p.chips.map(hexToUnitRgb);
    const avg = [0, 1, 2].map(
      (c) => (chips.reduce((s, rgb) => s + rgb[c], 0) / chips.length) * p.opacity * MEAN_COVERAGE,
    );
    // Screen of the backlight and the average chip light, as the composite does.
    const screen = (c: number) => 1 - (1 - bg[c]) * (1 - avg[c]);
    const mean: Rgb = [screen(0), screen(1), screen(2)];
    d = { bg, surround: hexToUnitRgb(p.surround), chips, opacity: p.opacity, mean };
    DATA.set(p, d);
  }
  return d;
}

/** Shape codes for the instance attribute; 3 to 6 are polygons with that many sides. */
export const SHAPE_DISC = 0;
export const SHAPE_BEAD = 1;
export const SHAPE_ROD = 2;

/** Chips per radian of wedge, so the chamber is equally full at any segment count. */
export const CHIPS_PER_RADIAN = 40;
/** How far a chip's centre keeps from a mirror or the rim, as a fraction of its bounding radius. */
export const WALL_PAD = 0.45;
/** Width of the soft band inside the padded walls, in units, and its spring rate (1/s^2). */
const SOFT_BAND = 0.05;
const SOFT_SPRING = 0.6;
/** Velocity relaxation time (s), wander speed (units/s) and swirl rate (rad/s). */
const RELAX = 1.5;
const DRIFT = 0.025;
const SWIRL = 0.08;
/** Fraction of the into-wall velocity kept (reversed) after a hard contact. */
const RESTITUTION = 0.4;
/** Smallest tumble foreshortening, so a chip never turns fully edge-on. */
const MIN_FLIP = 0.25;

/** Per-instance floats the sim writes before the spin pair: box (4), colour (4), shape (1). */
export const INSTANCE_ATTRIBUTES = [4, 4, 1] as const;
export const INSTANCE_STRIDE = 4 + 4 + 1 + 2;

export interface KaleidoSim {
  readonly segments: number;
  readonly seed: number;
  readonly count: number;
  /** Centres, in wedge units. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Bounding radius of each chip, in units. */
  readonly bound: Float64Array;
  /** Advances by `dt` seconds of sim time (already scaled by speed). */
  step: (dt: number) => void;
  /**
   * Writes every chip's instance (`INSTANCE_STRIDE` floats: centre, half extents,
   * colour and opacity, shape, then rotation and flip) with the given palette.
   * Returns the number of instances.
   */
  write: (data: Float32Array, pal: PaletteData) => number;
}

/** Glass chips in the wedge for `segments` mirrored segments; deterministic per seed. */
export function createKaleido(segments: number, seed: number): KaleidoSim {
  const w = wedgeAngle(segments);
  const sinW = Math.sin(w);
  const cosW = Math.cos(w);
  const count = Math.round(CHIPS_PER_RADIAN * w);
  const rng = createRng(seed * 7919 + segments);
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const vx = new Float64Array(count);
  const vy = new Float64Array(count);
  const hx = new Float64Array(count);
  const hy = new Float64Array(count);
  const bound = new Float64Array(count);
  const shape = new Uint8Array(count);
  const colour = new Uint8Array(count);
  const shade = new Float64Array(count);
  const alpha = new Float64Array(count);
  const angle = new Float64Array(count);
  const spin = new Float64Array(count);
  const tumble = new Float64Array(count);
  const tumbleRate = new Float64Array(count);
  const wander = new Float64Array(count * 4);
  const swirl = (rng() < 0.5 ? -1 : 1) * SWIRL;
  // Centroid the swirl turns about: on the bisector, a little past the middle.
  const cx = 0.55 * Math.cos(w / 2);
  const cy = 0.55 * Math.sin(w / 2);
  let time = 0;

  for (let i = 0; i < count; i++) {
    const kind = rng();
    if (kind < 0.5) {
      shape[i] = 3 + Math.floor(rng() * 4);
      hx[i] = hy[i] = 0.06 + 0.08 * rng();
      alpha[i] = 0.5 + 0.2 * rng();
    } else if (kind < 0.68) {
      shape[i] = SHAPE_DISC;
      hx[i] = hy[i] = 0.04 + 0.05 * rng();
      alpha[i] = 0.45 + 0.2 * rng();
    } else if (kind < 0.84) {
      shape[i] = SHAPE_BEAD;
      hx[i] = hy[i] = 0.018 + 0.02 * rng();
      alpha[i] = 0.85;
    } else {
      shape[i] = SHAPE_ROD;
      hy[i] = 0.009 + 0.007 * rng();
      hx[i] = hy[i] + 0.06 + 0.08 * rng();
      alpha[i] = 0.75;
    }
    bound[i] = Math.max(hx[i], hy[i]);
    colour[i] = Math.floor(rng() * 64);
    shade[i] = 0.8 + 0.3 * rng();
    const r = Math.sqrt(rng());
    const a = rng() * w;
    x[i] = r * Math.cos(a);
    y[i] = r * Math.sin(a);
    angle[i] = rng() * TAU;
    spin[i] = (rng() < 0.5 ? -1 : 1) * (0.05 + 0.2 * rng());
    // Beads are round every way up, so they never tumble.
    const round = shape[i] === SHAPE_BEAD;
    tumble[i] = round ? 0 : rng() * TAU;
    tumbleRate[i] = round ? 0 : 0.05 + 0.15 * rng();
    for (let k = 0; k < 4; k++) {
      wander[i * 4 + k] = k < 2 ? 0.05 + 0.1 * rng() : rng() * TAU;
    }
    confine(i);
  }

  /**
   * Hard constraint: keeps chip i's centre in the wedge shrunk by its pad, in polar
   * form so the apex (where both mirrors bind) can't push it out the other side.
   * Removes and partly reverses any velocity into a wall it touched.
   */
  function confine(i: number) {
    const pad = WALL_PAD * bound[i];
    let r = Math.hypot(x[i], y[i]);
    let a = r > 0 ? Math.atan2(y[i], x[i]) : w / 2;
    const rMin = pad / Math.sin(w / 2);
    const rMax = 1 - pad;
    let hitRim = false;
    if (r > rMax) {
      r = rMax;
      hitRim = true;
    } else if (r < rMin) {
      r = rMin;
    }
    const aMin = Math.asin(Math.min(1, pad / r));
    let hitFirst = false;
    let hitSecond = false;
    // Measure from the bisector, so a point anywhere outside goes to the nearer mirror.
    let d = a - w / 2;
    if (d > Math.PI) {
      d -= TAU;
    } else if (d <= -Math.PI) {
      d += TAU;
    }
    a = w / 2 + d;
    if (a < aMin) {
      a = aMin;
      hitFirst = true;
    } else if (a > w - aMin) {
      a = w - aMin;
      hitSecond = true;
    }
    x[i] = r * Math.cos(a);
    y[i] = r * Math.sin(a);
    if (hitFirst) {
      bounce(i, 0, 1);
    }
    if (hitSecond) {
      bounce(i, sinW, -cosW);
    }
    if (hitRim) {
      bounce(i, -x[i] / r, -y[i] / r);
    }
  }

  /** Reverses (with restitution) the velocity component against inward normal (nx, ny). */
  function bounce(i: number, nx: number, ny: number) {
    const vn = vx[i] * nx + vy[i] * ny;
    if (vn < 0) {
      vx[i] -= (1 + RESTITUTION) * vn * nx;
      vy[i] -= (1 + RESTITUTION) * vn * ny;
    }
  }

  /** Soft spring from a wall at distance d (inward normal n) once inside the band past the pad. */
  function push(i: number, d: number, pad: number, nx: number, ny: number, dt: number) {
    const depth = pad + SOFT_BAND - d;
    if (depth <= 0) {
      return;
    }
    vx[i] += SOFT_SPRING * depth * nx * dt;
    vy[i] += SOFT_SPRING * depth * ny * dt;
  }

  return {
    segments,
    seed,
    count,
    x,
    y,
    bound,
    step(dt) {
      if (!(dt > 0)) {
        return;
      }
      time += dt;
      const relax = 1 - Math.exp(-dt / RELAX);
      for (let i = 0; i < count; i++) {
        const o = i * 4;
        const tx = DRIFT * Math.sin(wander[o] * time + wander[o + 2]) - swirl * (y[i] - cy);
        const ty = DRIFT * Math.sin(wander[o + 1] * time + wander[o + 3]) + swirl * (x[i] - cx);
        vx[i] += (tx - vx[i]) * relax;
        vy[i] += (ty - vy[i]) * relax;
        const pad = WALL_PAD * bound[i];
        const r = Math.hypot(x[i], y[i]);
        push(i, y[i], pad, 0, 1, dt);
        push(i, x[i] * sinW - y[i] * cosW, pad, sinW, -cosW, dt);
        if (r > 0) {
          push(i, 1 - r, pad, -x[i] / r, -y[i] / r, dt);
        }
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
        confine(i);
        angle[i] = (angle[i] + spin[i] * dt) % TAU;
        tumble[i] = (tumble[i] + tumbleRate[i] * dt) % TAU;
      }
    },
    write(data, pal) {
      const n = pal.chips.length;
      for (let i = 0; i < count; i++) {
        const o = i * INSTANCE_STRIDE;
        const rgb = pal.chips[colour[i] % n];
        const c = Math.cos(tumble[i]);
        data[o] = x[i];
        data[o + 1] = y[i];
        data[o + 2] = hx[i];
        data[o + 3] = hy[i];
        data[o + 4] = Math.min(1, rgb[0] * shade[i]);
        data[o + 5] = Math.min(1, rgb[1] * shade[i]);
        data[o + 6] = Math.min(1, rgb[2] * shade[i]);
        data[o + 7] = alpha[i] * pal.opacity;
        data[o + 8] = shape[i];
        data[o + 9] = angle[i];
        data[o + 10] = (c < 0 ? -1 : 1) * Math.max(MIN_FLIP, Math.abs(c));
      }
      return count;
    },
  };
}
