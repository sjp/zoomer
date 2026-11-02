/**
 * Small, dependency-free, seeded noise toolkit shared by effects.
 *
 * - `createRng(seed)`: fast deterministic PRNG (mulberry32), returns floats in [0, 1).
 * - `hash32(x)` / `HASH32_GLSL`: the lowbias32 integer hash, identical in JS and GLSL.
 * - `createNoise(seed)`: a noise source with
 *   - `noise2(x, y)` / `noise3(x, y, z)`: simplex noise in roughly [-1, 1];
 *   - `periodic2(x, y, px, py)`: gradient (Perlin) noise in roughly [-1, 1] that
 *     tiles seamlessly with integer periods `px`, `py` (each at most 256).
 * - `fbm2`, `fbm3`, `fbmPeriodic2`: fractal Brownian motion (summed octaves) over
 *   the above, normalised back to roughly [-1, 1].
 *
 * Noise is relatively expensive in JavaScript (tens of nanoseconds per sample), so
 * effects should evaluate it into small offscreen textures and upscale/pan them,
 * never per full-resolution pixel per frame.
 */

export interface Noise {
  /** 2D simplex noise, roughly in [-1, 1]. */
  noise2(x: number, y: number): number;
  /** 3D simplex noise, roughly in [-1, 1]. Use `z` as time for evolving 2D fields. */
  noise3(x: number, y: number, z: number): number;
  /**
   * 2D gradient noise, roughly in [-1, 1], that repeats every `px` units in x and
   * `py` units in y. Periods must be positive integers no greater than 256.
   */
  periodic2(x: number, y: number, px: number, py: number): number;
}

/** Deterministic PRNG (mulberry32). Any number works as a seed; floats are truncated. */
export function createRng(seed: number): () => number {
  let a = (Math.imul(Math.floor(seed) | 0, 0x9e3779b1) ^ 0x6d2b79f5) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 32-bit integer hash (Chris Wellons' lowbias32): well mixed, cheap, and the same
 * as `hash32` in `HASH32_GLSL`, so JS can derive seeds the shader agrees with.
 * Takes any number (truncated to 32 bits); returns an unsigned 32-bit integer.
 */
export function hash32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** GLSL for `uint hash32(uint x)`, the shader twin of `hash32`. */
export const HASH32_GLSL = /* glsl */ `
uint hash32(uint x) {
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}
`;

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

/** The 12 edge-midpoint gradients of a cube, flattened as x,y,z triples. */
const GRAD3 = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1,
  0, 1, -1, 0, -1, -1,
]);

/** 8 unit gradients for 2D gradient noise, flattened as x,y pairs. */
const S = Math.SQRT1_2;
const GRAD2 = new Float64Array([1, 0, -1, 0, 0, 1, 0, -1, S, S, -S, S, S, -S, -S, -S]);

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export function createNoise(seed: number): Noise {
  const rng = createRng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }

  const noise2 = (x: number, y: number): number => {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = permMod12[ii + perm[jj]] * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = permMod12[ii + i1 + perm[jj + j1]] * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = permMod12[ii + 1 + perm[jj + 1]] * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2);
    }
    return 70 * n;
  };

  const noise3 = (x: number, y: number, z: number): number => {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);
    // Simplex ordering, set field by field: no per-call array allocation, as
    // effects call this per particle per frame.
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    let i2 = 0;
    let j2 = 0;
    let k2 = 0;
    if (x0 >= y0) {
      i2 = 1;
      if (y0 >= z0) {
        i1 = 1;
        j2 = 1;
      } else if (x0 >= z0) {
        i1 = 1;
        k2 = 1;
      } else {
        k1 = 1;
        k2 = 1;
      }
    } else {
      j2 = 1;
      if (y0 < z0) {
        k1 = 1;
        k2 = 1;
      } else if (x0 < z0) {
        j1 = 1;
        k2 = 1;
      } else {
        j1 = 1;
        i2 = 1;
      }
    }
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = permMod12[ii + perm[jj + perm[kk]]] * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      t3 *= t3;
      n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
    }
    return 32 * n;
  };

  const periodic2 = (x: number, y: number, px: number, py: number): number => {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const fx = x - xf;
    const fy = y - yf;
    // Wrap lattice coordinates before hashing so the gradients repeat exactly.
    let x0 = (xf | 0) % px;
    let y0 = (yf | 0) % py;
    if (x0 < 0) x0 += px;
    if (y0 < 0) y0 += py;
    const x1 = x0 + 1 === px ? 0 : x0 + 1;
    const y1 = y0 + 1 === py ? 0 : y0 + 1;
    const h0 = perm[x0];
    const h1 = perm[x1];
    const g00 = (perm[h0 + y0] & 7) * 2;
    const g10 = (perm[h1 + y0] & 7) * 2;
    const g01 = (perm[h0 + y1] & 7) * 2;
    const g11 = (perm[h1 + y1] & 7) * 2;
    const n00 = GRAD2[g00] * fx + GRAD2[g00 + 1] * fy;
    const n10 = GRAD2[g10] * (fx - 1) + GRAD2[g10 + 1] * fy;
    const n01 = GRAD2[g01] * fx + GRAD2[g01 + 1] * (fy - 1);
    const n11 = GRAD2[g11] * (fx - 1) + GRAD2[g11 + 1] * (fy - 1);
    const u = fade(fx);
    const v = fade(fy);
    const a = n00 + (n10 - n00) * u;
    const b = n01 + (n11 - n01) * u;
    return (a + (b - a) * v) * Math.SQRT2;
  };

  return { noise2, noise3, periodic2 };
}

/** Per-octave offset so successive octaves don't share a lattice origin. */
const OCTAVE_SHIFT = 19.19;

/**
 * 2D fBm over simplex noise: `octaves` layers, each `lacunarity` times the
 * frequency and `gain` times the amplitude of the last. Result is roughly in [-1, 1].
 */
export function fbm2(
  noise: Noise,
  x: number,
  y: number,
  octaves = 5,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    const shift = o * OCTAVE_SHIFT;
    sum += amp * noise.noise2(x * f + shift, y * f - shift);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** 3D fBm over simplex noise; see `fbm2`. Use `z` as time for evolving 2D fields. */
export function fbm3(
  noise: Noise,
  x: number,
  y: number,
  z: number,
  octaves = 5,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    const shift = o * OCTAVE_SHIFT;
    sum += amp * noise.noise3(x * f + shift, y * f - shift, z * f + shift);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/**
 * Seamlessly tiling 2D fBm: repeats every `period` units in both x and y.
 * Lacunarity is fixed at 2 so each octave's period stays an integer; `period`
 * must be a positive integer and `period * 2^(octaves-1)` at most 256.
 */
export function fbmPeriodic2(
  noise: Noise,
  x: number,
  y: number,
  period: number,
  octaves = 5,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    const shift = o * OCTAVE_SHIFT;
    const p = period * f;
    sum += amp * noise.periodic2(x * f + shift, y * f - shift, p, p);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}
