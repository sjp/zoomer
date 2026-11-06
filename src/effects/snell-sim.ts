/**
 * Pure CPU-side logic for Snell's window: the refraction optics (the JS twin of
 * the shader's), the window geometry, the ripple slope map, the palettes, the
 * floating motes and the drifting leaf's schedule. No GL here, so it is unit
 * tested directly.
 *
 * Geometry: the frame shows the underside of the surface at a fixed scale, in
 * reference px (1080 tall, y down), with the viewer's eye `depth * DEPTH_REF`
 * reference px below the point straight overhead (the window centre). The view
 * ray to a surface point P is `normalize(P.x, P.y, D)`, so the window's rim (the
 * critical angle) sits at |P| = D·tan(θc): the window grows with depth while the
 * ripples keep their on-screen size.
 */

import type { Rgb } from "./color";
import { hash32, createNoise, fbmPeriodic2 } from "./noise";
import { wrap } from "./math";
import type { AboveId, WaterId } from "./snell.meta";

const TAU = Math.PI * 2;

/** Refractive index of water for the green channel (air is 1). */
export const WATER_IOR = 1.333;
/**
 * Indices for R, G and B. Real dispersion (about 1.331 to 1.338) is doubled so
 * the rim's rainbow fringe reads at video-call resolution.
 */
export const RGB_IOR: readonly [number, number, number] = [1.326, WATER_IOR, 1.342];

/** Eye depth in reference px at `depth` 1. */
export const DEPTH_REF = 300;
/** Window centre in reference px from the top: high, so the speaker sits below it. */
export const WINDOW_Y = 320;

/** Critical angle in radians for light leaving water of index `ior` into air. */
export function criticalAngle(ior = WATER_IOR): number {
  return Math.asin(1 / ior);
}

/** Eye depth in reference px for the `depth` param. */
export function eyeDepth(depth: number): number {
  return Math.max(0.05, depth) * DEPTH_REF;
}

/** Window radius in reference px for a flat surface: D·tan(θc). */
export function windowRadius(depth: number, ior = WATER_IOR): number {
  return eyeDepth(depth) * Math.tan(criticalAngle(ior));
}

/**
 * Fresnel transmittance (unpolarised) from water of index `eta` into air, for
 * the cosine `ci` of the angle between the ray and the surface normal. Exactly
 * 0 at and beyond the critical angle, where `ct` is 0 and both ratios are 1:
 * the shader relies on that instead of branching.
 */
export function fresnelTransmit(ci: number, eta: number): number {
  const s2 = eta * eta * (1 - ci * ci);
  const ct = Math.sqrt(Math.max(1 - s2, 0));
  const rs = (eta * ci - ct) / (eta * ci + ct);
  const rp = (ci - eta * ct) / (ci + eta * ct);
  return 1 - 0.5 * (rs * rs + rp * rp);
}

/**
 * Refracts the view ray from the eye (`depthPx` below the window centre) to the
 * surface point (`px`, `py`) through a surface with slope (`gx`, `gy`) into air,
 * writing the unit direction (x, y, z up) to `out`. Returns the transmittance;
 * 0 means total internal reflection, and `out` is then left unchanged. The JS
 * twin of the shader's optics.
 */
export function refractUp(
  out: Float64Array,
  px: number,
  py: number,
  depthPx: number,
  gx: number,
  gy: number,
  eta = WATER_IOR,
): number {
  const il = 1 / Math.hypot(px, py, depthPx);
  const ix = px * il;
  const iy = py * il;
  const iz = depthPx * il;
  // Surface normal pointing up, out of the water.
  const nl = 1 / Math.hypot(gx, gy, 1);
  const nx = -gx * nl;
  const ny = -gy * nl;
  const nz = nl;
  const ci = ix * nx + iy * ny + iz * nz;
  const t = fresnelTransmit(ci, eta);
  if (!(t > 0)) {
    return 0;
  }
  const ct = Math.sqrt(1 - eta * eta * (1 - ci * ci));
  const k = ct - eta * ci;
  out[0] = eta * ix + k * nx;
  out[1] = eta * iy + k * ny;
  out[2] = eta * iz + k * nz;
  return t;
}

// ---------------------------------------------------------------------------
// Ripple slope map

/** Side of the slope map in texels. */
export const SLOPE_SIZE = 256;
/** Lattice cells across the map for the lowest octave. */
const SLOPE_PERIOD = 4;
const SLOPE_OCTAVES = 3;

/** Encodes a slope in [-1, 1] as a byte, with 0 exactly at 128. */
export function encodeSlope(v: number): number {
  const b = Math.round(128 + v * 127);
  return b < 1 ? 1 : b > 255 ? 255 : b;
}

/** Decodes `encodeSlope`; the shader does the same from the normalised texel. */
export function decodeSlope(b: number): number {
  return (b - 128) / 127;
}

/**
 * Builds a seamlessly tiling RG8 slope map (`size`² texels, two bytes each): the
 * x and y gradient of an fBm height field, by central differences with
 * wrap-around, scaled so the steepest slope encodes as ±1. The shader samples it
 * twice, at different scales, angles and drifts, for an irregular moving surface.
 */
export function buildSlopeMap(size = SLOPE_SIZE, seed = 0x5e11): Uint8Array {
  const noise = createNoise(seed);
  const k = SLOPE_PERIOD / size;
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      h[y * size + x] = fbmPeriodic2(noise, x * k, y * k, SLOPE_PERIOD, SLOPE_OCTAVES);
    }
  }
  const gx = new Float32Array(size * size);
  const gy = new Float32Array(size * size);
  let peak = 0;
  for (let y = 0; y < size; y++) {
    const up = ((y + size - 1) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x++) {
      const left = (x + size - 1) % size;
      const right = (x + 1) % size;
      const i = y * size + x;
      gx[i] = h[y * size + right] - h[y * size + left];
      gy[i] = h[down + x] - h[up + x];
      peak = Math.max(peak, Math.abs(gx[i]), Math.abs(gy[i]));
    }
  }
  const inv = peak > 0 ? 1 / peak : 0;
  const out = new Uint8Array(size * size * 2);
  for (let i = 0; i < size * size; i++) {
    out[i * 2] = encodeSlope(gx[i] * inv);
    out[i * 2 + 1] = encodeSlope(gy[i] * inv);
  }
  return out;
}

/** Ripple layers: tile period in reference px, drift in px/s (in the layer's frame). */
export const RIPPLE_A = { tile: 560, drift: [7.2, 5.4] } as const;
export const RIPPLE_B = { tile: 340, drift: [-6, 10.4] } as const;
/** Layer B is rotated by this angle (radians) so the two tilings never line up. */
export const RIPPLE_B_ANGLE = 1.1;
/** Weight of layer B relative to A. */
export const RIPPLE_B_WEIGHT = 0.8;
/** Peak surface slope at `ripples` 1. */
export const SLOPE_MAX = 0.3;

// ---------------------------------------------------------------------------
// Palettes

export interface WaterPalette {
  /** Reflected deep water, looking steeply down. */
  deep: Rgb;
  /** In-water haze, which far, slanting views fade to. */
  haze: Rgb;
  /** Absorption per DEPTH_REF of path: red goes first. */
  absorb: Rgb;
  /** Light shafts. */
  ray: Rgb;
}

export const WATER: Readonly<Record<WaterId, WaterPalette>> = {
  blue: {
    deep: [0.008, 0.05, 0.12],
    haze: [0.03, 0.17, 0.3],
    absorb: [0.55, 0.16, 0.08],
    ray: [0.55, 0.82, 1],
  },
  lake: {
    deep: [0.012, 0.06, 0.04],
    haze: [0.06, 0.2, 0.14],
    absorb: [0.6, 0.18, 0.4],
    ray: [0.7, 0.95, 0.7],
  },
  tropical: {
    deep: [0.01, 0.1, 0.14],
    haze: [0.04, 0.32, 0.38],
    absorb: [0.42, 0.07, 0.1],
    ray: [0.6, 1, 0.95],
  },
};

export interface SkyPalette {
  zenith: Rgb;
  horizon: Rgb;
  /** Sun colour (intensity may exceed 1), elevation and azimuth in degrees (0 = up the frame). */
  sun: Rgb;
  sunElevation: number;
  sunAzimuth: number;
  cloud: Rgb;
  cloudShade: Rgb;
  /** Cloud cover threshold: the noise value where clouds start and where they are solid. */
  cloudLo: number;
  cloudHi: number;
  /** Floating leaf tint, backlit. */
  leaf: Rgb;
  /** Canopy silhouettes ("Trees" only). */
  canopy: Rgb;
}

const DAY: SkyPalette = {
  zenith: [0.2, 0.45, 0.9],
  horizon: [0.75, 0.88, 1],
  sun: [1.6, 1.5, 1.3],
  sunElevation: 62,
  sunAzimuth: -35,
  cloud: [1, 1, 1],
  cloudShade: [0.72, 0.78, 0.88],
  cloudLo: 0.52,
  cloudHi: 0.64,
  leaf: [0.75, 0.45, 0.12],
  canopy: [0.05, 0.1, 0.05],
};

export const SKY: Readonly<Record<AboveId, SkyPalette>> = {
  sky: DAY,
  trees: { ...DAY, cloudLo: 0.56, cloudHi: 0.68, leaf: [0.45, 0.6, 0.15] },
  sunset: {
    zenith: [0.25, 0.22, 0.5],
    horizon: [1, 0.55, 0.3],
    sun: [1.8, 1.1, 0.5],
    sunElevation: 9,
    sunAzimuth: -70,
    cloud: [1, 0.62, 0.5],
    cloudShade: [0.45, 0.3, 0.45],
    cloudLo: 0.5,
    cloudHi: 0.62,
    leaf: [0.8, 0.35, 0.1],
    canopy: [0.06, 0.04, 0.06],
  },
};

/**
 * Unit sun direction (x right, y down the frame, z up) for an elevation and an
 * azimuth in degrees, azimuth 0 pointing up the frame and positive to the right.
 */
export function sunDirection(out: Float64Array, elevationDeg: number, azimuthDeg: number): void {
  const e = (elevationDeg * Math.PI) / 180;
  const a = (azimuthDeg * Math.PI) / 180;
  out[0] = Math.cos(e) * Math.sin(a);
  out[1] = -Math.cos(e) * Math.cos(a);
  out[2] = Math.sin(e);
}

// ---------------------------------------------------------------------------
// Light shafts

/**
 * Table coordinate (0..1) of the angle around the window centre for an offset
 * (`dx`, `dy`, y down): 0.5 straight down, the seam (0 and 1) straight up, where
 * the shafts are off-screen above the window. The shader's twin is
 * `atan(P.x, P.y) / TAU + 0.5`.
 */
export function shaftCoord(dx: number, dy: number): number {
  return Math.atan2(dx, dy) / TAU + 0.5;
}

// ---------------------------------------------------------------------------
// Motes

/** Mote count, radius range (reference px) and drift speed (reference px/s). */
export const MOTE_COUNT = 36;
const MOTE_MIN_R = 1.4;
const MOTE_MAX_R = 3.6;
const MOTE_DRIFT = 6;
/** How far past an edge a mote goes before it wraps to the other side. */
export const MOTE_MARGIN = 12;
const REF_HEIGHT = 1080;

/** Structure-of-arrays mote state, positions in reference px (y down). */
export interface MoteState {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly r: Float32Array;
  readonly phase: Float32Array;
  readonly freq: Float32Array;
}

/** `count` motes spread over a `refWidth` x 1080 frame. */
export function createMotes(rng: () => number, count: number, refWidth: number): MoteState {
  const s: MoteState = {
    x: new Float32Array(count),
    y: new Float32Array(count),
    vx: new Float32Array(count),
    vy: new Float32Array(count),
    r: new Float32Array(count),
    phase: new Float32Array(count),
    freq: new Float32Array(count),
  };
  for (let i = 0; i < count; i++) {
    s.x[i] = rng() * refWidth;
    s.y[i] = rng() * REF_HEIGHT;
    const a = rng() * TAU;
    const v = MOTE_DRIFT * (0.3 + 0.7 * rng());
    s.vx[i] = Math.cos(a) * v;
    // A slight net sink: motes settle slowly.
    s.vy[i] = Math.sin(a) * v + 1.5;
    const t = rng();
    s.r[i] = MOTE_MIN_R + (MOTE_MAX_R - MOTE_MIN_R) * t * t;
    s.phase[i] = rng() * TAU;
    s.freq[i] = 0.25 + 0.5 * rng();
  }
  return s;
}

/** Drifts every mote by `dt` seconds, wrapping it around the frame past a small margin. */
export function stepMotes(s: MoteState, dt: number, refWidth: number): void {
  const span = refWidth + 2 * MOTE_MARGIN;
  const spanY = REF_HEIGHT + 2 * MOTE_MARGIN;
  for (let i = 0; i < s.x.length; i++) {
    s.x[i] = wrap(s.x[i] + s.vx[i] * dt, -MOTE_MARGIN, span);
    s.y[i] = wrap(s.y[i] + s.vy[i] * dt, -MOTE_MARGIN, spanY);
  }
}

/** Scales every mote's x by `k`, keeping motes in place relative to a resized width. */
export function rescaleMotes(s: MoteState, k: number): void {
  for (let i = 0; i < s.x.length; i++) {
    s.x[i] *= k;
  }
}

/**
 * Brightness of mote `i` at `time`: it catches the light most near the window
 * (radius `radius`, centre `cx`, `cy`) and glints slowly as it tumbles.
 */
export function moteBrightness(
  s: MoteState,
  i: number,
  time: number,
  cx: number,
  cy: number,
  radius: number,
): number {
  const d = Math.hypot(s.x[i] - cx, s.y[i] - cy) / (1.4 * radius);
  const near = 0.2 + 0.8 * Math.exp(-d * d);
  const glint = 0.55 + 0.45 * Math.sin(time * s.freq[i] + s.phase[i]);
  return near * glint;
}

// ---------------------------------------------------------------------------
// Floating leaf

/** Seconds a leaf takes to cross the frame, and the pause before the next one. */
export const LEAF_CROSS = 100;
export const LEAF_GAP = 50;
export const LEAF_CYCLE = LEAF_CROSS + LEAF_GAP;
/** Leaf half-length and half-width in reference px. */
export const LEAF_LENGTH = 34;
export const LEAF_WIDTH = 14;
/** Largest sideways offset of a leaf's track from the window centre, in reference px. */
export const LEAF_OFFSET = 180;

/** A leaf's pose on the surface, relative to the window centre (reference px, y down). */
export interface LeafPose {
  x: number;
  y: number;
  angle: number;
}

/**
 * Half the length of a leaf's track: far enough that it starts and ends wholly
 * off a `refWidth` x 1080 frame wherever the track runs.
 */
export function leafReach(refWidth: number): number {
  return (
    Math.hypot(refWidth / 2, Math.max(WINDOW_Y, REF_HEIGHT - WINDOW_Y)) + LEAF_OFFSET + LEAF_LENGTH
  );
}

/**
 * Where the leaf is at `time` seconds: each LEAF_CYCLE, one leaf drifts in a
 * straight line across the frame past the window centre for LEAF_CROSS seconds,
 * on a track chosen by hashing the cycle number, turning slowly as it goes.
 * Returns false (pose unchanged) during the pause between leaves.
 */
export function leafAt(out: LeafPose, time: number, refWidth: number, seed = 0): boolean {
  const cycle = Math.floor(time / LEAF_CYCLE);
  const t = time - cycle * LEAF_CYCLE;
  if (!(t < LEAF_CROSS)) {
    return false;
  }
  const h1 = hash32((cycle * 3 + 1) ^ seed);
  const h2 = hash32((cycle * 3 + 2) ^ seed);
  const h3 = hash32((cycle * 3 + 3) ^ seed);
  const dir = (h1 / 4294967296) * TAU;
  const off = (h2 / 4294967296 - 0.5) * 2 * LEAF_OFFSET;
  const spin = (h3 / 4294967296 - 0.5) * 0.04;
  const reach = leafReach(refWidth);
  const along = -reach + (2 * reach * t) / LEAF_CROSS;
  const dx = Math.cos(dir);
  const dy = Math.sin(dir);
  out.x = dx * along - dy * off;
  out.y = dy * along + dx * off;
  out.angle = dir + 0.4 + spin * t;
  return true;
}
