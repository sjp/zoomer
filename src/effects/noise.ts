/**
 * Small, dependency-free, seeded noise toolkit shared by effects.
 *
 * - `createRng(seed)`: fast deterministic PRNG (mulberry32), returns floats in [0, 1).
 * - `hash32(x)` / `HASH32_GLSL`: the lowbias32 integer hash, identical in JS and GLSL.
 * - `createNoise(seed)`: a noise source with
 *   - `noise2(x, y)` / `noise3(x, y, z)`: simplex noise in roughly [-1, 1];
 *   - `periodic2(x, y, px, py)`: gradient (Perlin) noise in roughly [-1, 1] that
 *     tiles seamlessly with integer periods `px`, `py` (each at most 256; see
 *     `toPeriod` for what happens to other values).
 * - `fbm2`, `fbm3`, `fbmPeriodic2`: fractal Brownian motion (summed octaves) over
 *   the above, normalised back to roughly [-1, 1].
 * - `buildPeriodicNoiseTexture`: seamlessly tiling 8-bit noise texture data.
 *
 * Noise is relatively expensive in JavaScript (tens of nanoseconds per sample), so
 * effects should evaluate it into small offscreen textures and upscale/pan them,
 * never per full-resolution pixel per frame.
 */

/** Plain functions (closures, not methods), so they can be passed around unbound. */
export interface Noise {
  /** 2D simplex noise, roughly in [-1, 1]. */
  noise2: (x: number, y: number) => number;
  /** 3D simplex noise, roughly in [-1, 1]. Use `z` as time for evolving 2D fields. */
  noise3: (x: number, y: number, z: number) => number;
  /**
   * 2D gradient noise, roughly in [-1, 1], that repeats every `px` units in x and
   * `py` units in y. Periods should be positive integers no greater than 256;
   * others are coerced by `toPeriod` rather than reading past the permutation table.
   */
  periodic2: (x: number, y: number, px: number, py: number) => number;
}

/** Deterministic PRNG (mulberry32). Any number works as a seed; floats are truncated. */
export function createRng(seed: number): () => number {
  let a = (Math.imul(Math.floor(seed), 0x9e3779b1) ^ 0x6d2b79f5) >>> 0;
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

/**
 * `hashCell(cell)`: a uniform 0..1 value for an integer lattice cell (floored),
 * hashed with lowbias32 (it includes `HASH32_GLSL`) so every GPU agrees.
 */
export const HASH_CELL_GLSL = /* glsl */ `
${HASH32_GLSL}
float hashCell(vec2 c) {
  uvec2 u = uvec2(ivec2(floor(c)) + 65536);
  return float(hash32(u.x ^ hash32(u.y + 0x9e3779b9u))) / 4294967296.0;
}
`;

/**
 * Seeded 2D value noise, `vnoise(p, seed)` in 0..1, hashed with lowbias32 (it
 * includes `HASH32_GLSL`) so every GPU agrees. `hash2(cell, seed)` is the
 * per-lattice-point value.
 */
export const VALUE_NOISE_GLSL = /* glsl */ `
${HASH32_GLSL}
float hash2(vec2 c, float s) {
  uvec2 u = uvec2(ivec2(floor(c)) + 65536);
  return float(hash32(u.x ^ hash32(u.y ^ hash32(uint(s) + 0x9e3779b9u)))) / 4294967296.0;
}
float vnoise(vec2 p, float s) {
  vec2 i = floor(p);
  vec2 t = fract(p);
  t = t * t * (3.0 - 2.0 * t);
  return mix(mix(hash2(i, s), hash2(i + vec2(1.0, 0.0), s), t.x),
             mix(hash2(i + vec2(0.0, 1.0), s), hash2(i + vec2(1.0, 1.0), s), t.x), t.y);
}
`;

/** Four octaves of `VALUE_NOISE_GLSL`, `fbm(p, seed)` in 0..1. Include after it. */
export const VALUE_FBM_GLSL = /* glsl */ `
float fbm(vec2 p, float s) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p, s);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v / 0.9375;
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

/** Largest period `periodic2` supports: the size of its permutation table. */
export const MAX_PERIOD = 256;

/**
 * Coerces a lattice period to what `periodic2` can tile with: rounded to an
 * integer and clamped to [1, MAX_PERIOD]. NaN becomes 1. Valid periods pass
 * through unchanged.
 */
export function toPeriod(p: number): number {
  // Fast path for valid periods: periodic2 coerces on every call.
  if (p >= 1 && p <= MAX_PERIOD && Number.isInteger(p)) {
    return p;
  }
  return p >= 1 ? Math.min(MAX_PERIOD, Math.round(p)) : 1;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export function createNoise(seed: number): Noise {
  const rng = createRng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    p[i] = i;
  }
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
    const i1 = Number(x0 > y0);
    const j1 = 1 - i1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    // Branch-free like `noise3` (see there): weights are clamped to 0, and the
    // triangle choice `i1` and the NaN check on return are plain comparisons.
    const t0 = Math.max(0, 0.5 - x0 * x0 - y0 * y0);
    const t1 = Math.max(0, 0.5 - x1 * x1 - y1 * y1);
    const t2 = Math.max(0, 0.5 - x2 * x2 - y2 * y2);
    const g0 = permMod12[ii + perm[jj]] * 3;
    const g1 = permMod12[ii + i1 + perm[jj + j1]] * 3;
    const g2 = permMod12[ii + 1 + perm[jj + 1]] * 3;
    const w0 = t0 * t0;
    const w1 = t1 * t1;
    const w2 = t2 * t2;
    let n = 0;
    n += w0 * w0 * (GRAD3[g0] * x0 + GRAD3[g0 + 1] * y0);
    n += w1 * w1 * (GRAD3[g1] * x1 + GRAD3[g1 + 1] * y1);
    n += w2 * w2 * (GRAD3[g2] * x2 + GRAD3[g2 + 1] * y2);
    return Number.isNaN(n) ? 0 : 70 * n;
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
    // Which simplex the point is in, and which corners fall inside the kernel, are
    // unpredictable from call to call, and branching on them cost more than the
    // arithmetic. So both are branch-free: the ordering is built from 0/1
    // comparisons (corner 1 steps along the largest offset, corner 2 along the two
    // largest, x before y before z on ties), and corner weights are clamped to 0, so
    // an outside corner adds exactly ±0.
    const xy = Number(x0 >= y0);
    const xz = Number(x0 >= z0);
    const yz = Number(y0 >= z0);
    const i1 = xy & xz;
    const j1 = (1 - xy) & yz;
    const k1 = 1 - i1 - j1;
    const i2 = xy | xz;
    const j2 = (1 - xy) | yz;
    const k2 = 1 - (xz & yz);
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
    const t0 = Math.max(0, 0.6 - x0 * x0 - y0 * y0 - z0 * z0);
    const t1 = Math.max(0, 0.6 - x1 * x1 - y1 * y1 - z1 * z1);
    const t2 = Math.max(0, 0.6 - x2 * x2 - y2 * y2 - z2 * z2);
    const t3 = Math.max(0, 0.6 - x3 * x3 - y3 * y3 - z3 * z3);
    const g0 = permMod12[ii + perm[jj + perm[kk]]] * 3;
    const g1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
    const g2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
    const g3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
    const w0 = t0 * t0;
    const w1 = t1 * t1;
    const w2 = t2 * t2;
    const w3 = t3 * t3;
    let n = 0;
    n += w0 * w0 * (GRAD3[g0] * x0 + GRAD3[g0 + 1] * y0 + GRAD3[g0 + 2] * z0);
    n += w1 * w1 * (GRAD3[g1] * x1 + GRAD3[g1 + 1] * y1 + GRAD3[g1 + 2] * z1);
    n += w2 * w2 * (GRAD3[g2] * x2 + GRAD3[g2 + 1] * y2 + GRAD3[g2 + 2] * z2);
    n += w3 * w3 * (GRAD3[g3] * x3 + GRAD3[g3 + 1] * y3 + GRAD3[g3 + 2] * z3);
    // Only when every corner is outside can an offset be non-finite (huge or
    // non-finite coordinates), making 0 * Infinity = NaN where the sum is 0.
    return Number.isNaN(n) ? 0 : 32 * n;
  };

  const periodic2 = (x: number, y: number, px: number, py: number): number => {
    // Out-of-range or fractional periods would index past `perm` and return NaN.
    // The Math.imul(v, 1)s around toPeriod (a no-op on its integers) and each `%`
    // keep the wrap in int32 arithmetic: a negative multiple of the period gives
    // -0, and without them that makes `%` a much slower floating-point modulo.
    px = Math.imul(toPeriod(px), 1);
    py = Math.imul(toPeriod(py), 1);
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const fx = x - xf;
    const fy = y - yf;
    // Wrap lattice coordinates before hashing so the gradients repeat exactly.
    // Math.imul(v, 1) is ToInt32(v), as `v | 0`: huge or non-finite coordinates still index `perm`.
    let x0 = Math.imul(Math.imul(xf, 1) % px, 1);
    let y0 = Math.imul(Math.imul(yf, 1) % py, 1);
    if (x0 < 0) {
      x0 += px;
    }
    if (y0 < 0) {
      y0 += py;
    }
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
  return norm > 0 ? sum / norm : 0;
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
  return norm > 0 ? sum / norm : 0;
}

/**
 * Seamlessly tiling 2D fBm: repeats every `period` units in both x and y.
 * Lacunarity is fixed at 2 so each octave's period stays an integer. `period` is
 * coerced by `toPeriod`; octaves whose period `period * 2^o` would exceed
 * MAX_PERIOD are dropped, so the result still tiles. Zero octaves return 0.
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
  const base = toPeriod(period);
  for (let o = 0; o < octaves; o++) {
    const p = base * f;
    if (p > MAX_PERIOD) {
      break;
    }
    const shift = o * OCTAVE_SHIFT;
    sum += amp * noise.periodic2(x * f + shift, y * f - shift, p, p);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

/** One channel of `buildPeriodicNoiseTexture`. */
export interface NoiseChannel {
  /** Lattice cells across the texture side; a positive integer, at most 256. */
  period: number;
  /** Seed of the channel's own permutation, so channels are decorrelated. */
  seed: number;
}

/**
 * Builds a `size` x `size` 8-bit texture, row-major with `channels.length` bytes per
 * texel (RG8 for two channels, RGBA8 for four), for sampling with REPEAT wrapping.
 * Each channel is one octave of seamlessly tiling gradient noise (`periodic2`)
 * mapped from [-1, 1] to 0..255, so 128 is mid-grey. `size` should be a multiple
 * of every period so each lattice cell spans whole texels.
 */
export function buildPeriodicNoiseTexture(
  size: number,
  channels: readonly NoiseChannel[],
): Uint8Array {
  const stride = channels.length;
  const data = new Uint8Array(size * size * stride);
  channels.forEach(({ period, seed }, c) => {
    const noise = createNoise(seed);
    const k = period / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = noise.periodic2(x * k, y * k, period, period);
        const b = Math.round((v * 0.5 + 0.5) * 255);
        data[(y * size + x) * stride + c] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
    }
  });
  return data;
}
