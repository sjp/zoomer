/**
 * Pure JS side of the Nebula effect: palettes, the seeded layout (noise offsets
 * and the bright core), the drift of the warp and layer offsets, a CPU twin of the
 * gas shader (for dimming stars that sit in dense gas) and star generation.
 *
 * Coordinates: "gas space" is centred on the canvas, in canvas heights, y up, and
 * rotates slowly with the nebula. The shader maps a pixel to gas space with the
 * rotation, then samples a tiling 4-octave noise texture (one octave per channel).
 */
import { fract, smoothstep } from "../math";
import { lookup } from "../lookup";
import { buildPeriodicNoiseTexture, createRng, type NoiseChannel } from "../noise";

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

/** Three emission colours per preset, brightest layer first. */
export const PALETTES = {
  orion: ["#e0407a", "#2fb8c4", "#f2b54a"],
  carina: ["#f0a040", "#c8463a", "#3aa0b8"],
  veil: ["#22d3c5", "#c23cff", "#4a6cff"],
} as const satisfies Record<string, readonly [string, string, string]>;

/**
 * Emission colour `index` (0..2) of `palette`. "custom" picks c1..c3; unknown
 * palettes fall back to Orion. Allocates nothing, so it is safe per frame.
 */
export function paletteColor(
  palette: string,
  index: number,
  c1: string,
  c2: string,
  c3: string,
): string {
  const i = index <= 0 ? 0 : index >= 2 ? 2 : Math.floor(index);
  if (palette === "custom") {
    return i === 0 ? c1 : i === 1 ? c2 : c3;
  }
  const list: readonly string[] = lookup(PALETTES, palette, "orion");
  return list[i];
}

// ---------------------------------------------------------------------------
// Noise texture and gas model (shared constants with the shader)
// ---------------------------------------------------------------------------

/** Noise texture side, in texels. */
export const NOISE_SIZE = 256;
/** Lattice cells across the texture, one octave per RGBA channel. */
const NOISE_PERIODS = [2, 4, 8, 16] as const;
const NOISE_SEED = 29;

function nebulaNoiseChannels(seed = NOISE_SEED): NoiseChannel[] {
  return NOISE_PERIODS.map((period, c) => ({ period, seed: seed * 37 + c * 1013 + 5 }));
}

let noiseData: Uint8Array | undefined;
/** The RGBA8 noise texture data, built once per page (about 10 ms). */
export const getNoiseData = (): Uint8Array => {
  noiseData ??= buildPeriodicNoiseTexture(NOISE_SIZE, nebulaNoiseChannels());
  return noiseData;
};

/** Octave weights for the 4-channel fBm fetch. */
export const OCT = [0.5, 0.25, 0.125, 0.0625] as const;
/** Mean of dot(texel, OCT) for mid-grey texels. */
export const MEAN = 0.46875;
/** Brings the 4-octave sum to roughly unit standard deviation. */
export const NORM = 10;

/** Warp fetch frequency (texture units per canvas height). */
export const WARP_FREQ = 0.3;
/** Warp displacement of the gas layers and dust, in canvas heights per unit (rg - 0.5). */
export const WARP_AMT = 0.32;
export const DUST_WARP = 0.45;
/** Gas layer frequencies (texture units per canvas height). */
export const LAYER_FREQ = [0.55, 0.8, 1.1] as const;
/** Gas layer gains, folded into the colour uniforms. */
export const LAYER_GAIN = [1, 0.75, 0.55] as const;
/** Exposure before the soft tone curve, folded into the colour uniforms. */
export const EXPOSURE = 1.6;
/** Dust lane frequency; higher than the gas so the lanes are sharper. */
export const DUST_FREQ = 1.4;
/** Dust lanes ramp from 0 to full between these fBm values: a sharp edge. */
export const DUST_LO = 0;
export const DUST_HI = 0.9;
/** Fraction of the gas a full-strength lane removes. */
export const DUST_DEPTH = 0.92;
/** Width (in fBm standard deviations) of the gas threshold ramp: a soft edge. */
export const GAS_SOFT = 2.2;
/** Brightness envelope: a base level plus a Gaussian core. */
export const ENV_BASE = 0.35;
export const ENV_CORE = 1.4;
/** Core radius (1/e), canvas heights. */
export const CORE_RADIUS = 0.45;
/** Uneven brightness: the envelope is scaled by PATCH_LO + PATCH_SPAN * warp.b. */
export const PATCH_LO = 0.55;
export const PATCH_SPAN = 0.9;
/** Near-black base colour. */
export const BASE_RGB = [0.006, 0.007, 0.016] as const;

/** Gas threshold (in fBm standard deviations) for a density of 0..1. */
export function densityThreshold(density: number): number {
  const d = density <= 0 ? 0 : density >= 1 ? 1 : density;
  return 0.8 - 2.2 * d;
}

// ---------------------------------------------------------------------------
// Layout and drift
// ---------------------------------------------------------------------------

/** Rotation in rad per (speed-scaled) second: 1 degree per minute. */
const ROTATION_RATE = Math.PI / 180 / 60;
const TAU = Math.PI * 2;

/**
 * Drift of each offset pair in texture units per (speed-scaled) second: warp,
 * gas layers 0..2, dust. The warp moves fastest, so shapes deform in place rather
 * than scroll; the layers drift slowly in different directions.
 */
const DRIFT = [
  0.0041, -0.0029, 0.0012, 0.0007, -0.0009, 0.0011, 0.0006, -0.0013, -0.0011, -0.0006,
] as const;
/** Floats in an offsets array: five xy pairs (warp, layer 0, 1, 2, dust). */
export const OFFSET_FLOATS = 10;

export interface NebulaLayout {
  /** Seeded base offsets, texture units in [0, 1), OFFSET_FLOATS values. */
  base: Float64Array;
  /** Side of the canvas the core sits on: -1 left, 1 right. */
  side: number;
  /** 0..1 position of the core within its band (x), and its height (y). */
  coreU: number;
  coreV: number;
}

export function createLayout(seed: number): NebulaLayout {
  const rng = createRng(Math.floor(seed) * 7919 + 101);
  const base = new Float64Array(OFFSET_FLOATS);
  for (let i = 0; i < OFFSET_FLOATS; i++) {
    base[i] = rng();
  }
  return { base, side: rng() < 0.5 ? -1 : 1, coreU: rng(), coreV: rng() };
}

/**
 * Core centre in gas space for a canvas aspect (width / height): in an outer
 * third of the frame, so the speaker doesn't cover it.
 */
export function coreCentre(layout: NebulaLayout, aspect: number, out: Float64Array): void {
  out[0] = layout.side * (0.22 + 0.1 * layout.coreU) * aspect;
  out[1] = (layout.coreV - 0.5) * 0.3;
}

/**
 * Fills `out` (OFFSET_FLOATS) with the offsets at simulation time `t` (seconds
 * times speed, unwrapped float64), each wrapped to [0, 1): the texture tiles at 1,
 * so the wrap is invisible. Allocates nothing.
 */
export function offsetsAt(layout: NebulaLayout, t: number, out: Float64Array | Float32Array): void {
  for (let i = 0; i < OFFSET_FLOATS; i++) {
    out[i] = fract(layout.base[i] + DRIFT[i] * t);
  }
}

/** Rotation angle at time `t`, wrapped to [0, 2pi) (exact: the rotation is periodic). */
export function rotationAt(t: number): number {
  return fract((ROTATION_RATE * t) / TAU) * TAU;
}

// ---------------------------------------------------------------------------
// CPU twin of the gas shader
// ---------------------------------------------------------------------------

/**
 * Bilinear, REPEAT-wrapped sample of RGBA8 texture data at (u, v) in texture units,
 * as the GPU does (texel centres at half-integers), into `out` as 0..1.
 */
export function sampleNoise(
  data: Uint8Array,
  size: number,
  u: number,
  v: number,
  out: Float64Array,
): void {
  const x = u * size - 0.5;
  const y = v * size - 0.5;
  const xf = Math.floor(x);
  const yf = Math.floor(y);
  const fx = x - xf;
  const fy = y - yf;
  const x0 = ((xf % size) + size) % size;
  const y0 = ((yf % size) + size) % size;
  const x1 = x0 + 1 === size ? 0 : x0 + 1;
  const y1 = y0 + 1 === size ? 0 : y0 + 1;
  const i00 = (y0 * size + x0) * 4;
  const i10 = (y0 * size + x1) * 4;
  const i01 = (y1 * size + x0) * 4;
  const i11 = (y1 * size + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const a = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * fx;
    const b = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * fx;
    out[c] = (a + (b - a) * fy) / 255;
  }
}

const texel = new Float64Array(4);

/** Centred, normalised 4-octave fBm at (u, v), as `fbm()` in the shader. */
function fbmAt(data: Uint8Array, u: number, v: number): number {
  sampleNoise(data, NOISE_SIZE, u, v, texel);
  return (
    (texel[0] * OCT[0] + texel[1] * OCT[1] + texel[2] * OCT[2] + texel[3] * OCT[3] - MEAN) * NORM
  );
}

function emission(n: number, threshold: number): number {
  const g = smoothstep(threshold, threshold + GAS_SOFT, n);
  return g * g;
}

/**
 * Gas amount at gas-space point (qx, qy): the sum of the three layer emissions
 * (weighted by LAYER_GAIN and EXPOSURE), times the brightness envelope and the
 * dust transmission. The shader's colour is `1 - 2^-(sum of colour * emission)`,
 * so `1 - 2^-gasAmount` is its brightness for white layers.
 */
export function gasAmount(
  data: Uint8Array,
  qx: number,
  qy: number,
  offsets: ArrayLike<number>,
  threshold: number,
  dust: number,
  core: ArrayLike<number>,
): number {
  sampleNoise(data, NOISE_SIZE, qx * WARP_FREQ + offsets[0], qy * WARP_FREQ + offsets[1], texel);
  const wx = texel[0] - 0.5;
  const wy = texel[1] - 0.5;
  const patch = PATCH_LO + PATCH_SPAN * texel[2];
  const gx = qx + wx * WARP_AMT;
  const gy = qy + wy * WARP_AMT;
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const n = fbmAt(
      data,
      gx * LAYER_FREQ[i] + offsets[2 + i * 2],
      gy * LAYER_FREQ[i] + offsets[3 + i * 2],
    );
    sum += emission(n, threshold) * LAYER_GAIN[i];
  }
  const dn = fbmAt(
    data,
    (qx + wx * DUST_WARP) * DUST_FREQ + offsets[8],
    (qy + wy * DUST_WARP) * DUST_FREQ + offsets[9],
  );
  const lane = smoothstep(DUST_LO, DUST_HI, dn) * dust * DUST_DEPTH;
  const dx = qx - core[0];
  const dy = qy - core[1];
  const env =
    (ENV_BASE + ENV_CORE * Math.exp(-(dx * dx + dy * dy) / (CORE_RADIUS * CORE_RADIUS))) * patch;
  return sum * EXPOSURE * env * (1 - lane);
}

// ---------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------

/** Floats per star instance: x, y (gas space), radius (1080p px), brightness, r, g, b. */
export const STAR_STRIDE = 7;
/** Stars per unit area (canvas heights squared) at full star density. */
const STARS_PER_AREA = 400;
/** Stars are generated over a disc this big (covers a 3:1 canvas at any rotation). */
const STAR_DISC = 0.5 * Math.sqrt(10) + 0.02;
export const MAX_STARS = Math.ceil(STARS_PER_AREA * Math.PI * STAR_DISC * STAR_DISC);
/** Brightness power law: P(b > x) = (x / STAR_MIN)^-STAR_ALPHA, capped at STAR_MAX. */
export const STAR_MIN = 0.15;
export const STAR_MAX = 4;
export const STAR_ALPHA = 1.6;
/** How many of the brightest on-screen stars get diffraction spikes. */
export const SPIKE_STARS = 3;
/** Minimum brightness for a spike. */
export const SPIKE_MIN = 1.2;
/** How much the densest gas dims a star (fraction). */
const STAR_DIM = 0.55;

/** Star brightness for a uniform u in [0, 1): a Pareto (power-law) draw, capped. */
export function starBrightness(u: number): number {
  const tail = 1 - u;
  return tail <= 0 ? STAR_MAX : Math.min(STAR_MAX, STAR_MIN * tail ** (-1 / STAR_ALPHA));
}

/** Halo radius (1080p px) for a star brightness: tiny points for most, soft glows for the bright. */
function starRadius(b: number): number {
  const t = Math.min(1, Math.max(0, (b - 0.4) / (STAR_MAX - 0.4)));
  return 1.7 + 4.5 * t ** 0.7;
}

/** Radius of the disc that covers a canvas of this aspect at any rotation. */
export function coverRadius(aspect: number): number {
  return 0.5 * Math.sqrt(aspect * aspect + 1) + 0.02;
}

/** Number of seeded star draws for a star density (0..1). */
function starDraws(density: number): number {
  const d = density <= 0 ? 0 : density >= 1 ? 1 : density;
  return Math.round(d * MAX_STARS);
}

interface StarResult {
  /** Stars written. */
  count: number;
  /** The first `spikes` stars are the ones to draw with spikes. */
  spikes: number;
}

/**
 * Fills `out` with star instances (STAR_STRIDE floats each) from a fixed seeded
 * sequence over the STAR_DISC, keeping those inside the disc that covers this
 * aspect, so changing the density or aspect adds or removes stars without moving
 * the others. Brightness follows `starBrightness`, times `dim(x, y)` (gas
 * dimming, 1 by default). With `spikes`, the SPIKE_STARS brightest stars that are
 * on screen, outside the middle third and at least SPIKE_MIN bright are moved to
 * the front.
 */
export function buildStars(
  out: Float32Array,
  seed: number,
  density: number,
  aspect: number,
  spikes: boolean,
  dim: (x: number, y: number) => number = () => 1,
): StarResult {
  const rng = createRng(Math.floor(seed) * 104729 + 7);
  const draws = starDraws(density);
  const max = Math.floor(out.length / STAR_STRIDE);
  const r2 = coverRadius(aspect) ** 2;
  let n = 0;
  for (let i = 0; i < draws && n < max; i++) {
    // Always four draws per star, so the sequence doesn't depend on what is kept.
    const ur = rng();
    const ua = rng();
    const ub = rng();
    const ut = rng();
    const rr = STAR_DISC * STAR_DISC * ur;
    if (rr > r2) {
      continue;
    }
    const r = Math.sqrt(rr);
    const a = ua * Math.PI * 2;
    const x = r * Math.cos(a);
    const y = r * Math.sin(a);
    const b = starBrightness(ub);
    const o = n * STAR_STRIDE;
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = starRadius(b);
    out[o + 3] = b;
    // Tint: blue-white through white to pale gold, hotter stars commoner.
    const warm = ut * ut;
    out[o + 4] = 0.78 + 0.22 * warm;
    out[o + 5] = 0.86 + 0.04 * warm;
    out[o + 6] = 1 - 0.3 * warm;
    n++;
  }

  let spikeCount = 0;
  if (spikes) {
    const halfW = aspect / 2 - 0.02;
    const third = aspect / 6;
    for (let k = 0; k < SPIKE_STARS; k++) {
      let best = -1;
      let bestB = SPIKE_MIN;
      for (let i = k; i < n; i++) {
        const o = i * STAR_STRIDE;
        const ax = Math.abs(out[o]);
        if (ax < third || ax > halfW || Math.abs(out[o + 1]) > 0.48) {
          continue;
        }
        if (out[o + 3] >= bestB) {
          bestB = out[o + 3];
          best = i;
        }
      }
      if (best < 0) {
        break;
      }
      swapStars(out, k, best);
      spikeCount++;
    }
  }

  for (let i = 0; i < n; i++) {
    const o = i * STAR_STRIDE;
    out[o + 3] *= dim(out[o], out[o + 1]);
  }
  return { count: n, spikes: spikeCount };
}

function swapStars(out: Float32Array, i: number, j: number): void {
  if (i === j) {
    return;
  }
  const a = i * STAR_STRIDE;
  const b = j * STAR_STRIDE;
  for (let c = 0; c < STAR_STRIDE; c++) {
    const t = out[a + c];
    out[a + c] = out[b + c];
    out[b + c] = t;
  }
}

/** Star dimming factor for a gas amount (see `gasAmount`). */
export function starDim(amount: number): number {
  return 1 - STAR_DIM * (1 - 2 ** -Math.max(0, amount));
}
