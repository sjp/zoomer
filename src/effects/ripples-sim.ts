/**
 * CPU side of the pond-ripples effect: the drop ring buffer, the rain spawner,
 * the ring profile and its gradient (the JS twin of the shader's), the per-frame
 * uniform packing and the reflected-branch mask. No GL here, so it is unit tested
 * directly.
 *
 * Each drop sends out one wave packet: `A(age) · env(u) · cos(k (r − ρ))`, where
 * `ρ` is the packet's radius, `u = (r − ρ) / W` and `env(u) = (1 − u²)²` for
 * |u| < 1 and 0 beyond. The envelope and its derivative both vanish at |u| = 1,
 * so the profile has compact support and a continuous gradient, and every pixel
 * outside the annulus `ρ ± W` skips the drop. `W` spans 1.25 wavelengths, so a
 * packet shows two or three crests. Times are kept in float64 on the CPU and only
 * ages and radii (a few hundred pixels at most) reach the shader.
 */

import { approach } from "./math";
import { createNoise, fbm2 } from "./noise";

const TAU = Math.PI * 2;

/** Most drops alive at once; the oldest is recycled beyond this. */
export const MAX_DROPS = 32;
/** Floats per drop in the packed uniform array: two vec4s. */
export const DROP_STRIDE = 8;

/** Ring speed in reference px per second at `ringSpeed` 1. */
export const BASE_SPEED = 55;
/** Ring wavelength in reference px at birth, at `ringSize` 1. */
export const BASE_WAVELENGTH = 20;
/** Packet half-width in wavelengths: 2.5 wavelengths across, so 2–3 crests. */
export const PACKET_HALF = 1.25;
/** Relative wavelength growth per second of age: rings widen as they spread. */
export const SPREAD = 0.3;
/** Longest a ring lives, in seconds (at low rates). */
export const MAX_LIFE = 4;
/** Shortest a ring lives, so a heavy shower still shows rings, not blips. */
export const MIN_LIFE = 1.5;
/** At most this fraction of the buffer is in use at the current rate. */
const FILL = 0.85;
/** How fast the lifespan follows the rate, in seconds per second. */
const LIFE_RATE = 0.75;
/** Seconds a ring takes to fade in after the drop lands. */
export const FADE_IN = 0.2;
/** Peak slope of a fresh ring at full drop strength. */
export const RING_AMP = 0.35;
/** Rate swing at `variation` 1: the rate varies by ±85 %. */
export const RATE_SWING = 0.85;

// ---------------------------------------------------------------------------
// Ring profile

/**
 * Height of one ring packet at radius `r`, per unit amplitude: `env(u) · cos(k x)`
 * with `x = r − rho`, `u = x / halfWidth`. Exactly 0 for |u| >= 1.
 */
export function ringHeight(r: number, rho: number, halfWidth: number, k: number): number {
  const x = r - rho;
  const u = x / halfWidth;
  if (u * u >= 1) return 0;
  const e = 1 - u * u;
  return e * e * Math.cos(k * x);
}

/**
 * `d ringHeight / dr` divided by `k`: the ring's slope in units of its own
 * amplitude, independent of the wavelength. The shader evaluates exactly this.
 */
export function ringSlope(r: number, rho: number, halfWidth: number, k: number): number {
  const x = r - rho;
  const invW = 1 / halfWidth;
  const u = x * invW;
  if (u * u >= 1) return 0;
  const e = 1 - u * u;
  const ph = k * x;
  return -4 * u * e * (invW / k) * Math.cos(ph) - e * e * Math.sin(ph);
}

/**
 * Amplitude of a ring of `age` seconds whose drops live `life` seconds: a short
 * fade-in, then a quadratic fade to exactly 0 at `life`.
 */
export function ringAmplitude(age: number, life: number): number {
  if (!(age > 0) || !(age < life)) return 0;
  const f = age < FADE_IN ? age / FADE_IN : 1;
  const fadeIn = f * f * (3 - 2 * f);
  const t = 1 - age / life;
  return fadeIn * t * t;
}

// ---------------------------------------------------------------------------
// Drop ring buffer

export interface DropBuffer {
  /** Position as a fraction of the frame width and height (y up, as gl_FragCoord). */
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Strength, 0..1. */
  readonly amp: Float32Array;
  /** Sim time at birth (float64). */
  readonly birth: Float64Array;
  /** The radius clock (`RainState.dist`) at birth, so speed changes never jump. */
  readonly birthDist: Float64Array;
  /** Drops written so far, capped at the buffer size. */
  count: number;
  /** Next slot to write: the oldest drop once the buffer is full. */
  head: number;
}

export function createDropBuffer(cap: number): DropBuffer {
  const n = Math.max(1, Math.floor(cap));
  return {
    x: new Float32Array(n),
    y: new Float32Array(n),
    amp: new Float32Array(n),
    birth: new Float64Array(n),
    birthDist: new Float64Array(n),
    count: 0,
    head: 0,
  };
}

/** Writes a drop over the oldest slot; returns the slot index. */
export function addDrop(
  b: DropBuffer,
  x: number,
  y: number,
  amp: number,
  birth: number,
  birthDist: number,
): number {
  const i = b.head;
  b.x[i] = x;
  b.y[i] = y;
  b.amp[i] = amp;
  b.birth[i] = birth;
  b.birthDist[i] = birthDist;
  const cap = b.x.length;
  b.head = (i + 1) % cap;
  if (b.count < cap) b.count++;
  return i;
}

// ---------------------------------------------------------------------------
// Rain

/** Slow rate wobble in [-1, 1] with zero mean: two incommensurate sines. */
export function rateWobble(t: number): number {
  return 0.6 * Math.sin(t * 0.21 + 1.3) + 0.4 * Math.sin(t * 0.083 + 4.1);
}

/** Drops per second at sim time `t`: `rate` varied slowly by up to ±RATE_SWING. */
export function rateAt(rate: number, variation: number, t: number): number {
  const v = Math.min(1, Math.max(0, variation));
  return Math.max(0, rate * (1 + v * RATE_SWING * rateWobble(t)));
}

/** Ring lifespan to aim for at `rate`, so the buffer rarely recycles a visible ring. */
export function targetLife(rate: number, cap = MAX_DROPS): number {
  if (!(rate > 0)) return MAX_LIFE;
  return Math.min(MAX_LIFE, Math.max(MIN_LIFE, (FILL * cap) / rate));
}

export interface RainState {
  readonly drops: DropBuffer;
  /** Sim seconds, float64. */
  time: number;
  /** Radius clock: reference px a ring has travelled since time 0, float64. */
  dist: number;
  /** Expected drops accumulated towards the next one. */
  acc: number;
  /** Exponential(1) threshold for the next drop, so arrivals are Poisson. */
  next: number;
  /** Current ring lifespan, eased towards `targetLife`. */
  life: number;
  /** Drops spawned in total. */
  spawned: number;
}

export function createRainState(rng: () => number, cap = MAX_DROPS): RainState {
  return {
    drops: createDropBuffer(cap),
    time: 0,
    dist: 0,
    acc: 0,
    next: -Math.log(1 - rng()),
    life: MAX_LIFE,
    spawned: 0,
  };
}

/**
 * Advances the rain by `dt` seconds: the clocks, the lifespan, and Poisson
 * arrivals at the slowly varying rate (the accumulated expected count is
 * compared against exponential thresholds, so the long-run rate equals the mean
 * of `rateAt` even as it changes). `speed` is the ring speed in reference px/s.
 * Allocates nothing.
 */
export function stepRain(
  s: RainState,
  dt: number,
  rate: number,
  variation: number,
  speed: number,
  rng: () => number,
): void {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  s.time += dt;
  s.dist += Math.max(0, speed) * dt;
  const r = rateAt(Number.isFinite(rate) ? rate : 0, variation, s.time);
  s.life = approach(s.life, targetLife(r, s.drops.x.length), LIFE_RATE * dt);
  s.acc += r * dt;
  while (s.acc >= s.next) {
    s.acc -= s.next;
    s.next = -Math.log(1 - rng());
    // Drops land anywhere; a few are weaker, so the rings vary.
    addDrop(s.drops, rng(), rng(), 0.55 + 0.45 * rng(), s.time, s.dist);
    s.spawned++;
  }
}

/**
 * Packs the live rings into `out` (MAX_DROPS × two vec4s) in the pixel units of a
 * `width` × `height` target and returns how many were written:
 *
 * - `vec4(x, y, rOut², 1 / (W k))`: centre, outer radius squared for the early
 *   reject, and the envelope term of the slope;
 * - `vec4(ρ, 1 / W, k, A)`: packet radius, inverse half-width, wavenumber and
 *   amplitude.
 *
 * `pxPerRef` converts reference px to target px; `wavelength` is in reference px.
 * Rings that are dead, faded to nothing or not yet out of the centre are skipped.
 */
export function packDrops(
  out: Float32Array,
  s: RainState,
  width: number,
  height: number,
  pxPerRef: number,
  wavelength: number,
): number {
  const b = s.drops;
  const max = Math.min(b.count, Math.floor(out.length / DROP_STRIDE));
  let n = 0;
  for (let i = 0; i < b.count && n < max; i++) {
    const age = s.time - b.birth[i];
    const amp = RING_AMP * b.amp[i] * ringAmplitude(age, s.life);
    if (amp <= 1e-4) continue;
    const rho = (s.dist - b.birthDist[i]) * pxPerRef;
    const lambda = Math.max(1e-3, wavelength * (1 + SPREAD * age) * pxPerRef);
    const w = PACKET_HALF * lambda;
    const rOut = rho + w;
    if (rOut <= 0) continue;
    const k = TAU / lambda;
    const o = n * DROP_STRIDE;
    out[o] = b.x[i] * width;
    out[o + 1] = b.y[i] * height;
    out[o + 2] = rOut * rOut;
    out[o + 3] = 1 / (w * k);
    out[o + 4] = rho;
    out[o + 5] = 1 / w;
    out[o + 6] = k;
    out[o + 7] = amp;
    n++;
  }
  return n;
}

/**
 * The surface gradient (dimensionless slope) at pixel `(px, py)` from the first
 * `count` packed rings: the JS twin of the shader loop. It is the exact gradient
 * of `rippleHeight`.
 */
export function rippleGradient(
  packed: Float32Array,
  count: number,
  px: number,
  py: number,
  out: Float64Array | number[],
): void {
  let gx = 0;
  let gy = 0;
  for (let i = 0; i < count; i++) {
    const o = i * DROP_STRIDE;
    const dx = px - packed[o];
    const dy = py - packed[o + 1];
    const d2 = dx * dx + dy * dy;
    if (d2 >= packed[o + 2]) continue;
    const r = Math.sqrt(d2);
    const u = (r - packed[o + 4]) * packed[o + 5];
    if (u * u >= 1) continue;
    const e = 1 - u * u;
    const ph = (r - packed[o + 4]) * packed[o + 6];
    const slope =
      packed[o + 7] * (-4 * u * e * packed[o + 3] * Math.cos(ph) - e * e * Math.sin(ph));
    const inv = slope / Math.max(r, 1e-3);
    gx += dx * inv;
    gy += dy * inv;
  }
  out[0] = gx;
  out[1] = gy;
}

/** The surface height whose gradient `rippleGradient` gives: Σ (A / k) · ringHeight. */
export function rippleHeight(packed: Float32Array, count: number, px: number, py: number): number {
  let h = 0;
  for (let i = 0; i < count; i++) {
    const o = i * DROP_STRIDE;
    const r = Math.hypot(px - packed[o], py - packed[o + 1]);
    const k = packed[o + 6];
    h += (packed[o + 7] / k) * ringHeight(r, packed[o + 4], 1 / packed[o + 5], k);
  }
  return h;
}

// ---------------------------------------------------------------------------
// Reflected branches

export const BRANCH_W = 256;
export const BRANCH_H = 144;

/** Gaussian bump. */
const bump = (x: number, c: number, w: number) => Math.exp(-(((x - c) / w) ** 2));

/**
 * The reflected-branch mask, `width` × `height` R8 texels, row 0 at the bottom
 * (v = 0): overhanging foliage reaching in from the top edge, heaviest at the top
 * corners, and down the left edge, with a leafy noise fringe. Values 0..255
 * (255 = fully covered). Built once at creation.
 */
export function buildBranchMask(width = BRANCH_W, height = BRANCH_H, seed = 0x9e11): Uint8Array {
  const noise = createNoise(seed);
  const out = new Uint8Array(width * height);
  const aspect = width / height;
  for (let j = 0; j < height; j++) {
    const v = (j + 0.5) / height;
    for (let i = 0; i < width; i++) {
      const uu = (i + 0.5) / width;
      // How far each edge's canopy reaches in, as a fraction of the frame.
      const top =
        0.03 + 0.26 * bump(uu, 0, 0.22) + 0.16 * bump(uu, 1, 0.16) + 0.05 * bump(uu, 0.62, 0.08);
      const left = 0.02 + 0.1 * bump(v, 0.78, 0.25);
      const field = Math.max(top - (1 - v), (left - uu) * 0.8);
      // Leafy fringe: clumps at a few scales.
      const n = fbm2(noise, uu * 9 * aspect, v * 9, 4);
      const f = field + 0.075 * n;
      const m = Math.min(1, Math.max(0, f / 0.02 + 0.5));
      out[j * width + i] = Math.round(m * m * (3 - 2 * m) * 255);
    }
  }
  return out;
}
