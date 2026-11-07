/**
 * Pure JS logic for Iridescent Film (`film.ts`): the thin-film colour lookup
 * table (thickness to reflected colour, from the interference optics) and the
 * soap film's drainage profile. Nothing here touches GL, so it is all unit-tested.
 */
import { clamp } from "../math";

export type FilmMode = "soap" | "oil" | "pearl";

/** Unknown values fall back to soap. */
export function filmMode(mode: string): FilmMode {
  return mode === "oil" || mode === "pearl" ? mode : "soap";
}

/** Lookup-table entries; entry i is thickness `i / (TABLE_SIZE - 1) * MAX_THICKNESS`. */
export const TABLE_SIZE = 512;
/** Thickest film the table covers, in nm. Thicker films clamp to the last entry. */
export const MAX_THICKNESS = 1500;
/** Wavelength samples integrated per entry, evenly spaced over the visible range. */
export const WAVELENGTH_SAMPLES = 24;
const LAMBDA_MIN = 400;
const LAMBDA_MAX = 700;

export interface FilmLook {
  /** Refractive index of the film. */
  n: number;
  /** Colour saturation multiplier on the `saturation` param. */
  saturation: number;
  /** Mix of every colour towards white: pastel lift. */
  lift: number;
  /** Table alpha is `alphaFloor + alphaGain * luminance`, clamped to 1 (luminance 0..1). */
  alphaFloor: number;
  alphaGain: number;
}

const LOOKS: Readonly<Record<FilmMode, FilmLook>> = {
  // Water film in air: one half-wave phase shift, so a vanishing film is black.
  soap: { n: 1.33, saturation: 1, lift: 0, alphaFloor: 0, alphaGain: 2.2 },
  // Oil on water (n rises then falls): also one phase shift.
  oil: { n: 1.47, saturation: 1, lift: 0, alphaFloor: 0.05, alphaGain: 1.8 },
  // Nacre-like: same optics, washed out and lifted, mostly opaque over a light ground.
  pearl: { n: 1.5, saturation: 0.45, lift: 0.55, alphaFloor: 0.45, alphaGain: 0.55 },
};

export function filmLook(mode: string): FilmLook {
  return LOOKS[filmMode(mode)];
}

/** Two-sided Gaussian lobe used by the CIE fit. */
function lobe(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}

/**
 * CIE 1931 colour-matching functions at wavelength `lambda` (nm), from the
 * multi-lobe Gaussian fit of Wyman, Sloan and Shirley (2013). Writes X, Y, Z to `out`.
 */
export function cieXyz(lambda: number, out: Float64Array | number[]): void {
  out[0] =
    1.056 * lobe(lambda, 599.8, 37.9, 31.0) +
    0.362 * lobe(lambda, 442.0, 16.0, 26.7) -
    0.065 * lobe(lambda, 501.1, 20.4, 26.2);
  out[1] = 0.821 * lobe(lambda, 568.8, 46.9, 40.5) + 0.286 * lobe(lambda, 530.9, 16.3, 31.1);
  out[2] = 1.217 * lobe(lambda, 437.0, 11.8, 36.0) + 0.681 * lobe(lambda, 459.0, 26.0, 13.8);
}

/**
 * Thin-film reflectance at normal incidence, up to a constant: two-beam
 * interference with one half-wave phase shift, `sin^2(2 pi n d / lambda)`. Zero
 * for a vanishing film (the soap "black film").
 */
export function reflectance(d: number, lambda: number, n: number): number {
  const s = Math.sin((2 * Math.PI * n * d) / lambda);
  return s * s;
}

/** XYZ (D65 white) to linear sRGB. */
const XYZ_TO_RGB = [
  3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.204, 1.057,
] as const;

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Thickness (nm) of table entry `i`. */
export function entryThickness(i: number): number {
  return (i / (TABLE_SIZE - 1)) * MAX_THICKNESS;
}

/**
 * Builds the RGBA8 lookup table (TABLE_SIZE x 1): thickness to reflected colour
 * (sRGB-encoded RGB) and an alpha that rises with the film's brightness.
 *
 * For each entry, integrates the reflectance spectrum against the CIE fit, converts
 * to linear sRGB with a white balance that maps a flat spectrum to grey, scales
 * the saturation about the luminance, clamps out-of-gamut negatives, then
 * normalises so the brightest channel of the whole table is exactly 1 (so nothing
 * clips). Pearl then lifts every colour towards white.
 */
export function buildFilmTable(mode: string, saturation: number, out?: Uint8Array): Uint8Array {
  const look = filmLook(mode);
  const sat = clamp(Number.isFinite(saturation) ? saturation : 1, 0, 1) * look.saturation;
  const data = out ?? new Uint8Array(TABLE_SIZE * 4);
  const lin = new Float64Array(TABLE_SIZE * 3);
  const lum = new Float64Array(TABLE_SIZE);
  const cmf = new Float64Array(WAVELENGTH_SAMPLES * 3);
  const xyz = [0, 0, 0];
  const lambdas = new Float64Array(WAVELENGTH_SAMPLES);
  for (let k = 0; k < WAVELENGTH_SAMPLES; k++) {
    const lambda = LAMBDA_MIN + ((k + 0.5) / WAVELENGTH_SAMPLES) * (LAMBDA_MAX - LAMBDA_MIN);
    lambdas[k] = lambda;
    cieXyz(lambda, xyz);
    cmf[k * 3] = xyz[0];
    cmf[k * 3 + 1] = xyz[1];
    cmf[k * 3 + 2] = xyz[2];
  }
  // White balance: a flat reflectance of 1 maps to (1, 1, 1).
  let wx = 0;
  let wy = 0;
  let wz = 0;
  for (let k = 0; k < WAVELENGTH_SAMPLES; k++) {
    wx += cmf[k * 3];
    wy += cmf[k * 3 + 1];
    wz += cmf[k * 3 + 2];
  }
  const m = XYZ_TO_RGB;
  const wr = m[0] * wx + m[1] * wy + m[2] * wz;
  const wg = m[3] * wx + m[4] * wy + m[5] * wz;
  const wb = m[6] * wx + m[7] * wy + m[8] * wz;

  let maxC = 0;
  for (let i = 0; i < TABLE_SIZE; i++) {
    const d = entryThickness(i);
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < WAVELENGTH_SAMPLES; k++) {
      const r = reflectance(d, lambdas[k], look.n);
      x += r * cmf[k * 3];
      y += r * cmf[k * 3 + 1];
      z += r * cmf[k * 3 + 2];
    }
    let r = (m[0] * x + m[1] * y + m[2] * z) / wr;
    let g = (m[3] * x + m[4] * y + m[5] * z) / wg;
    let b = (m[6] * x + m[7] * y + m[8] * z) / wb;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = Math.max(0, l + sat * (r - l));
    g = Math.max(0, l + sat * (g - l));
    b = Math.max(0, l + sat * (b - l));
    lin[i * 3] = r;
    lin[i * 3 + 1] = g;
    lin[i * 3 + 2] = b;
    lum[i] = l;
    maxC = Math.max(maxC, r, g, b);
  }
  const inv = maxC > 0 ? 1 / maxC : 0;
  let maxL = 0;
  for (let i = 0; i < TABLE_SIZE; i++) {
    maxL = Math.max(maxL, lum[i]);
  }
  const invL = maxL > 0 ? 1 / maxL : 0;
  for (let i = 0; i < TABLE_SIZE; i++) {
    for (let c = 0; c < 3; c++) {
      const v = look.lift + (1 - look.lift) * lin[i * 3 + c] * inv;
      data[i * 4 + c] = Math.round(clamp(linearToSrgb(v), 0, 1) * 255);
    }
    const a = look.alphaFloor + look.alphaGain * lum[i] * invL;
    data[i * 4 + 3] = Math.round(clamp(a, 0, 1) * 255);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Soap drainage

/** Drainage profile exponent and the height (0 bottom, 1 top) where the film is thinnest. */
export const DRAIN_POWER = 0.8;
export const DRAIN_TOP = 1.03;

/**
 * Thickness multiplier of a draining vertical soap film at height `y` (0 at the
 * bottom of the frame, 1 at the top): `(DRAIN_POWER + 1) * (1 - y / DRAIN_TOP)^DRAIN_POWER`.
 * Averages about 1 over the frame, so the `thickness` param stays the mean; near
 * the top it falls towards 0, the black film. Mirrored by `drain()` in the shader.
 */
export function drainProfile(y: number): number {
  const t = Math.max(0, 1 - clamp(y, 0, 1) / DRAIN_TOP);
  return (DRAIN_POWER + 1) * Math.pow(t, DRAIN_POWER);
}
