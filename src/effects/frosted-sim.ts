/**
 * Pure JS logic for Frosted Glass (`frosted.ts`): palettes, glass presets, the
 * shapes' slow paths, the reeded-glass lens profile and the static grain texture.
 * Nothing here touches GL, so it is all unit-tested.
 */
import { lookup } from "./lookup";
import { buildPeriodicNoiseTexture, createRng, hash32 } from "./noise";
import { MAX_SHAPES } from "./frosted.meta";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Palettes

export const PALETTES = {
  dusk: ["#ff5e7a", "#7b4dff", "#ffb347"],
  lagoon: ["#00c2c7", "#2f6bff", "#9cf28a"],
  orchid: ["#e056fd", "#ff7eb3", "#5f6cff"],
  ember: ["#ff6a3d", "#ffcc33", "#d6246e"],
  slate: ["#7d8aa8", "#b7c3d9", "#4f5d7a"],
} as const satisfies Record<string, readonly string[]>;

/**
 * Hex colour of shape `index`: colours repeat every three shapes. "custom" uses
 * `custom`; unknown names (and an empty custom list) fall back to "dusk".
 */
export function shapeColor(palette: string, custom: readonly string[], index: number): string {
  const list: readonly string[] =
    palette === "custom" && custom.length > 0 ? custom : lookup(PALETTES, palette, "dusk");
  return list[((index % list.length) + list.length) % list.length];
}

// ---------------------------------------------------------------------------
// Glass presets

export interface GlassPreset {
  /** Multiplier on the `blur` param's edge width. */
  blur: number;
  /** Multiplier on the `frost` param's grain amplitude. */
  grain: number;
  /** Diagonal sheen strength (added colour units at the band's centre). */
  sheen: number;
  /** 0..1: how much of the reeded flute profile and edge highlight is applied. */
  flute: number;
  /** Mix towards white: the milky lift of diffusing glass. */
  milk: number;
}

export const GLASS = {
  frosted: { blur: 1, grain: 1, sheen: 0.05, flute: 0, milk: 0.035 },
  reeded: { blur: 0.6, grain: 0.35, sheen: 0.035, flute: 1, milk: 0.015 },
  clear: { blur: 0.35, grain: 0.2, sheen: 0.03, flute: 0, milk: 0 },
} as const satisfies Record<string, GlassPreset>;

/** The preset for a `glass` select value; unknown values fall back to "frosted". */
export function glassPreset(name: string): GlassPreset {
  return lookup(GLASS, name, "frosted");
}

// ---------------------------------------------------------------------------
// Shapes

export type ShapeKind = "disc" | "capsule" | "ring";

/**
 * One shape and its two-harmonic Lissajous path. Lengths in frame-height units,
 * angular rates in rad/s at speed 1.
 */
export interface ShapePath {
  kind: ShapeKind;
  /** Disc / capsule end radius, or ring centre-line radius. */
  radius: number;
  /** Capsule half-length (0 for discs and rings). */
  halfLen: number;
  /** Ring half-thickness (0 for discs and capsules). */
  ringHalf: number;
  ax: number;
  wx: number;
  px: number;
  ay: number;
  wy: number;
  py: number;
  /** Second-harmonic amplitude (fraction of width / height), shared by x and y. */
  wob: number;
  wx2: number;
  px2: number;
  wy2: number;
  py2: number;
  /** Rotation rate and phase. */
  wr: number;
  pr: number;
}

/** Main-loop periods in seconds at speed 1. */
export const MAIN_PERIOD = [45, 85] as const;
/** Wobble periods in seconds at speed 1. */
export const WOBBLE_PERIOD = [30, 60] as const;
/** Rotation periods in seconds at speed 1 (either direction). */
export const ROTATE_PERIOD = [70, 140] as const;

/** Order of shapes as the count rises: two shapes already mix a disc and a capsule. */
const KINDS: readonly ShapeKind[] = ["disc", "capsule", "ring", "disc", "capsule"];

/** Deterministic path table. Phases are golden-ratio spaced so any prefix is spread out. */
export function makeShapePaths(): ShapePath[] {
  const rng = createRng(0x6a55);
  const rate = ([lo, hi]: readonly [number, number]) => TAU / (lo + (hi - lo) * rng());
  const paths: ShapePath[] = [];
  for (let i = 0; i < MAX_SHAPES; i++) {
    const kind = KINDS[i];
    const g = (i * 0.618034) % 1;
    paths.push({
      kind,
      radius:
        kind === "ring"
          ? 0.2 + 0.04 * rng()
          : kind === "capsule"
            ? 0.1 + 0.04 * rng()
            : 0.14 + 0.08 * rng(),
      halfLen: kind === "capsule" ? 0.16 + 0.08 * rng() : 0,
      ringHalf: kind === "ring" ? 0.05 + 0.02 * rng() : 0,
      ax: 0.3 + 0.06 * rng(),
      wx: rate(MAIN_PERIOD),
      px: g * TAU,
      ay: 0.26 + 0.06 * rng(),
      wy: rate(MAIN_PERIOD),
      py: (g + 0.3) * TAU + rng(),
      wob: 0.04 + 0.02 * rng(),
      wx2: rate(WOBBLE_PERIOD),
      px2: rng() * TAU,
      wy2: rate(WOBBLE_PERIOD),
      py2: rng() * TAU,
      wr: rate(ROTATE_PERIOD) * (rng() < 0.5 ? -1 : 1),
      pr: rng() * TAU,
    });
  }
  return paths;
}

export const SHAPE_PATHS: readonly ShapePath[] = makeShapePaths();

/**
 * Shape centre and rotation at time `t` (seconds at speed 1), in frame-height
 * units with x in 0..aspect and y up. Writes x, y, angle to `out[o..o+2]`.
 */
export function shapeAt(
  path: ShapePath,
  t: number,
  aspect: number,
  out: Float32Array | number[],
  o = 0,
): void {
  const ux =
    0.5 + path.ax * Math.sin(t * path.wx + path.px) + path.wob * Math.sin(t * path.wx2 + path.px2);
  const uy =
    0.5 + path.ay * Math.sin(t * path.wy + path.py) + path.wob * Math.sin(t * path.wy2 + path.py2);
  out[o] = ux * aspect;
  out[o + 1] = uy;
  out[o + 2] = t * path.wr + path.pr;
}

/** Peak opacity of a shape over what lies below it, so the base always shows a little. */
export const SHAPE_OPACITY = 0.88;

/**
 * Fills the first `count` vec4s of the shader's two shape arrays:
 * - `a`: centre x, y, cos, sin of the rotation (the shader rotates into shape space);
 * - `b`: capsule half-length, radius, ring half-thickness, opacity (`weights[i]`,
 *   default 1, times `SHAPE_OPACITY`).
 * Later entries are left alone: the shader stops at `uCount`.
 */
export function writeShapeUniforms(
  a: Float32Array,
  b: Float32Array,
  count: number,
  t: number,
  aspect: number,
  weights?: ArrayLike<number>,
  scratch: number[] = [0, 0, 0],
): void {
  const n = Math.min(count, MAX_SHAPES);
  for (let i = 0; i < n; i++) {
    const path = SHAPE_PATHS[i];
    shapeAt(path, t, aspect, scratch);
    const o = i * 4;
    a[o] = scratch[0];
    a[o + 1] = scratch[1];
    a[o + 2] = Math.cos(scratch[2]);
    a[o + 3] = Math.sin(scratch[2]);
    b[o] = path.halfLen;
    b[o + 1] = path.radius;
    b[o + 2] = path.ringHalf;
    b[o + 3] = (weights ? weights[i] : 1) * SHAPE_OPACITY;
  }
}

// ---------------------------------------------------------------------------
// Blur

/** Edge half-width in frame heights at `blur` = 0 and 1 (before the glass multiplier). */
export const BLUR_RANGE = [0.05, 0.4] as const;

/**
 * Half-width of the shapes' smoothstep edge in frame-height units, for the `blur`
 * param (0..1) and the glass multiplier, kept at least `minWidth` (two low-res
 * texels) so edges never alias in the small target.
 */
export function blurWidth(blur: number, glassBlur: number, minWidth: number): number {
  const b = Number.isFinite(blur) ? Math.min(1, Math.max(0, blur)) : 0.5;
  const w = (BLUR_RANGE[0] + (BLUR_RANGE[1] - BLUR_RANGE[0]) * b) * glassBlur;
  return Math.max(minWidth, w);
}

// ---------------------------------------------------------------------------
// Reeded glass

/**
 * Lens strength of a flute: the slope of the sample offset at the flute centre,
 * so each flute shows a strip (1 + FLUTE_SQUASH) flute widths wide, squashed
 * into one.
 */
export const FLUTE_SQUASH = 1.6;

/** In-flute coordinate in [-0.5, 0.5) of device-pixel column `x`, for flutes `flutePx` wide. */
export function fluteCoord(x: number, flutePx: number): number {
  const f = x / flutePx;
  return f - Math.floor(f) - 0.5;
}

/**
 * The lens profile: horizontal sample offset, in flute widths, at in-flute
 * coordinate `u` (-0.5..0.5). Zero with slope `squash` at the centre, and smooth
 * there; bounded by `squash / PI` at the edges, where the jump to the next flute's
 * profile makes the visible seam. The shader computes `uFluteAmp * sin(PI * u)`
 * with `uFluteAmp = squash / PI * flutePx / width`.
 */
export function fluteOffset(u: number, squash = FLUTE_SQUASH): number {
  return (squash / Math.PI) * Math.sin(Math.PI * u);
}

// ---------------------------------------------------------------------------
// Grain texture

/** Grain texture side in texels; one texel per 1080p pixel, so it tiles every 256 px. */
export const GRAIN_SIZE = 256;
/** Lattice cells across the coarse (mottling) channel. */
export const GRAIN_COARSE_PERIOD = 8;

/**
 * The static frosting texture: RG8, `size` x `size`, REPEAT-wrapped. R is white
 * noise (one hashed byte per texel: the fine grain, which bilinear filtering
 * softens a little above 1080p); G is one octave of tiling gradient noise with
 * `coarsePeriod` cells (soft mottling). Both centre on 128.
 */
export function buildGrainTexture(
  size = GRAIN_SIZE,
  coarsePeriod = GRAIN_COARSE_PERIOD,
  seed = 0xf205,
): Uint8Array {
  const coarse = buildPeriodicNoiseTexture(size, [{ period: coarsePeriod, seed }]);
  const data = new Uint8Array(size * size * 2);
  for (let i = 0; i < size * size; i++) {
    data[i * 2] = hash32(i ^ Math.imul(seed, 0x9e3779b1)) >>> 24;
    data[i * 2 + 1] = coarse[i];
  }
  return data;
}
