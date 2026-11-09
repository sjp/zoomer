/**
 * Grass field's pure logic, kept free of GL so it can be tested: the blade
 * instance builder (deterministic per seed, sorted back to front), the wind
 * function's JS twin, the bend curve, and the field and sun palettes.
 *
 * Ground coordinates: `z` is depth (1 at the reference distance, larger is
 * further), `x` is lateral, in units where the grass band's height on screen
 * (horizon to bottom edge) is 1 at z = 1. A point at depth z appears
 * `span / z` px below the horizon, where `span` is that band's height in px.
 */
import { hexToUnitRgb, type Rgb } from "../color";
import { smoothstep } from "../math";
import { hash32 } from "../noise";

// --- Blades -----------------------------------------------------------------

/** Nearest and furthest blade depths. Roots nearer than 1 sit below the bottom edge. */
export const Z_NEAR = 0.8;
export const Z_FAR = 8;
/** 1 / Z_FAR: beyond this depth (smaller d) only the distance band is drawn. */
export const D_MIN = 1 / Z_FAR;
/** Blades at density 1 on a 16:9 frame. About 2.6x screen coverage of the grass band. */
export const BASE_COUNT = 18000;
/** Upper bound on blades (density 2 on a wide 32:9 frame). */
export const MAX_BLADES = 72000;
/** Floats per blade instance: x, z, height, width; tone, sway cycles, flex, lean. */
export const BLADE_FLOATS = 8;
/** Horizontal margin beyond each screen edge, as a fraction of the width, for bent blades. */
export const X_MARGIN = 0.08;
/** Blade height range at z = 1, in grass-band heights. */
export const HEIGHT_MIN = 0.3;
export const HEIGHT_MAX = 0.62;
/** Blade base width range at z = 1, in grass-band heights. */
export const WIDTH_MIN = 0.011;
export const WIDTH_MAX = 0.02;
/** Own-sway frequency range, in whole cycles per wind period (about 0.5 to 0.9 Hz at rest). */
export const SWAY_CYCLES_MIN = 300;
export const SWAY_CYCLES_MAX = 540;
/** Random rest lean, radians either side of upright. */
export const LEAN = 0.18;

/**
 * The blade strip: `(level, side)` per vertex, three segments of two vertices
 * each, then the tip. 7 vertices, 5 triangles.
 */
export const BLADE_STRIP: readonly number[] = [0, -1, 0, 1, 1, -1, 1, 1, 2, -1, 2, 1, 3, 0];
/** Segments per blade (levels 0..SEGMENTS, the last being the tip). */
export const SEGMENTS = 3;
/** How much of the full bend each segment takes, root to tip: the tip moves most. */
export const SEGMENT_BEND: readonly number[] = [0.19, 0.54, 1];

/** Blade count for a density and canvas aspect (width / height), clamped to MAX_BLADES. */
export function bladeCount(density: number, aspect: number): number {
  const n = Math.round(BASE_COUNT * Math.max(0, density) * (Math.max(0, aspect) / (16 / 9)));
  return Number.isFinite(n) ? Math.min(MAX_BLADES, n) : 0;
}

/** Uniform [0, 1) from the seed, the blade index and a field number. */
function unit(seed: number, i: number, k: number): number {
  return hash32(hash32(seed) ^ hash32(i * 8 + k)) / 4294967296;
}

/**
 * Every blade up to some count, sorted back to front once, so any smaller count
 * can be picked out without sorting again (`selectBlades`).
 */
export interface BladeField {
  /** Blades in the field. */
  count: number;
  /** BLADE_FLOATS per blade, back to front (decreasing z). */
  data: Float32Array;
  /** Each sorted blade's index: blade i depends only on the seed and i. */
  index: Uint32Array;
}

/**
 * Builds `count` blades for `seed`, sorted back to front (decreasing z, ties by
 * index). Depths are uniform in z, so blades get denser towards the horizon in
 * step with their shrinking size: screen coverage stays even down the band.
 * Allocates and sorts: build it once, then pick counts with `selectBlades`.
 */
export function buildBladeField(seed: number, count: number): BladeField {
  const n = Math.max(0, Math.floor(count));
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    z[i] = Z_NEAR + unit(seed, i, 1) * (Z_FAR - Z_NEAR);
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    order[i] = i;
  }
  // Far first; ties by index keep the order deterministic.
  order.sort((a, b) => z[b] - z[a] || a - b);
  const data = new Float32Array(n * BLADE_FLOATS);
  for (let j = 0; j < n; j++) {
    const i = order[j];
    const o = j * BLADE_FLOATS;
    data[o] = -X_MARGIN + unit(seed, i, 0) * (1 + 2 * X_MARGIN);
    data[o + 1] = z[i];
    data[o + 2] = HEIGHT_MIN + unit(seed, i, 2) * (HEIGHT_MAX - HEIGHT_MIN);
    data[o + 3] = WIDTH_MIN + unit(seed, i, 3) * (WIDTH_MAX - WIDTH_MIN);
    data[o + 4] = unit(seed, i, 4);
    data[o + 5] =
      SWAY_CYCLES_MIN + Math.floor(unit(seed, i, 5) * (SWAY_CYCLES_MAX - SWAY_CYCLES_MIN));
    data[o + 6] = 0.75 + 0.5 * unit(seed, i, 6);
    data[o + 7] = (unit(seed, i, 7) * 2 - 1) * LEAN;
  }
  return { count: n, data, index: order };
}

/**
 * Copies blades 0..count-1 of `field` into `out`, still back to front, and returns
 * how many it wrote (clamped to the field and to what `out` holds). One pass, no
 * sort and no allocation, so a count change (a resize or the density slider) is cheap.
 */
export function selectBlades(field: BladeField, count: number, out: Float32Array): number {
  const n = Math.max(0, Math.min(Math.floor(count), Math.floor(out.length / BLADE_FLOATS)));
  const { data, index } = field;
  let j = 0;
  for (let k = 0; k < field.count && j < n; k++) {
    if (index[k] < n) {
      const src = k * BLADE_FLOATS;
      const dst = j * BLADE_FLOATS;
      for (let f = 0; f < BLADE_FLOATS; f++) {
        out[dst + f] = data[src + f];
      }
      j++;
    }
  }
  return j;
}

/**
 * Fills `out` with `count` blades (BLADE_FLOATS each), sorted back to front, and
 * returns the count written (clamped to what `out` holds). Blade i's values depend
 * only on the seed and i, so raising the count adds blades without moving the others.
 */
export function buildBlades(seed: number, count: number, out: Float32Array): number {
  const n = Math.max(0, Math.min(Math.floor(count), Math.floor(out.length / BLADE_FLOATS)));
  return selectBlades(buildBladeField(seed, n), n, out);
}

// --- Wind -------------------------------------------------------------------

/**
 * Seconds of one wind period at rate 1. Every phase in the shader is a whole
 * number of cycles per period, so the CPU wraps the phase to [0, 1) without a jump.
 */
export const WIND_PERIOD = 600;
/** Wind phase advance per second, in periods: slow drift at rest, faster in strong wind. */
export const windRate = (wind: number) => (0.4 + 1.2 * Math.max(0, wind)) / WIND_PERIOD;

/** Gust-band noise: texture repeats per ground unit, and whole texture cycles per period. */
export const GUST_FX = 0.05;
export const GUST_FZ = 0.03;
export const GUST_CX = 30;
export const GUST_CZ = -6;
/** Combined gust noise (0..1) mapped through smoothstep(GUST_LO, GUST_HI): bands with gaps. */
export const GUST_LO = 0.38;
export const GUST_HI = 0.68;
/** Two travelling sine waves: cycles per ground unit (x, z) and cycles per period. */
export const WAVE1 = { kx: 0.33, kz: 0.07, n: 240, amp: 0.6 } as const;
export const WAVE2 = { kx: 0.58, kz: -0.12, n: 420, amp: 0.4 } as const;
/** Bend = wind * (BASE + SWAY * wave * (1 - gusts / 2) + GUST * gusts * gust). */
export const BEND_BASE = 0.3;
export const BEND_SWAY = 0.25;
export const BEND_GUST = 0.7;
/** Radians of tip bend per unit of bend, and the most a blade's tip may turn. */
export const MAX_BEND = 1.15;
export const BEND_LIMIT = 1.45;

/** Noise texture side and channel periods (R, G: gust bands; B, A: clouds and texture). */
export const NOISE_SIZE = 128;
export const NOISE_CHANNELS = [
  { period: 4, seed: 551 },
  { period: 8, seed: 552 },
  { period: 16, seed: 553 },
  { period: 32, seed: 554 },
] as const;

/** Texture coordinate of the gust noise at ground point (x, z) and wind phase, into `out`. */
export function gustUv(x: number, z: number, phase: number, out: [number, number]) {
  out[0] = x * GUST_FX - GUST_CX * phase;
  out[1] = z * GUST_FZ - GUST_CZ * phase;
  return out;
}

const fract = (v: number) => v - Math.floor(v);

/** Sum of the two travelling waves at (x, z), in [-1, 1]. */
export function windWave(x: number, z: number, phase: number): number {
  const tau = Math.PI * 2;
  const a = Math.sin(tau * fract(x * WAVE1.kx + z * WAVE1.kz - WAVE1.n * phase));
  const b = Math.sin(tau * fract(x * WAVE2.kx + z * WAVE2.kz - WAVE2.n * phase));
  return WAVE1.amp * a + WAVE2.amp * b;
}

/**
 * JS twin of the shader's `windAt`: the bend at ground point (x, z), given the
 * combined gust noise there (`0.7 * R + 0.3 * G`, 0..1, from `gustUv`). Lies in
 * [wind * (BASE - SWAY), wind * (BASE + SWAY + GUST)].
 */
export function windBend(
  x: number,
  z: number,
  phase: number,
  wind: number,
  gusts: number,
  gustNoise: number,
): number {
  const gust = smoothstep(GUST_LO, GUST_HI, gustNoise);
  const wave = windWave(x, z, phase);
  return wind * (BEND_BASE + BEND_SWAY * wave * (1 - 0.5 * gusts) + BEND_GUST * gusts * gust);
}

/**
 * Bilinear sample with REPEAT wrapping of channel `c` of an 8-bit texture
 * (`stride` bytes per texel), as the GPU's LINEAR filter does: 0..1.
 */
export function sampleRepeat(
  data: Uint8Array,
  size: number,
  stride: number,
  c: number,
  u: number,
  v: number,
): number {
  const fx = u * size - 0.5;
  const fy = v * size - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (x: number, y: number) => {
    const xi = ((x % size) + size) % size;
    const yi = ((y % size) + size) % size;
    return data[(yi * size + xi) * stride + c] / 255;
  };
  const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

// --- Bend curve -------------------------------------------------------------

/** Tip bend angle (radians) for a bend value, blade flex, own sway and rest lean. */
export function tipAngle(bend: number, flex: number, sway: number, lean: number): number {
  const a = lean + bend * MAX_BEND * flex + sway;
  return Math.max(-BEND_LIMIT, Math.min(BEND_LIMIT, a));
}

/**
 * Centre-line points of a blade of `length` whose tip turns `angle` radians from
 * upright (positive leans towards +x): SEGMENTS + 1 points as x, up pairs into
 * `out`, root at the origin. Equal segments, each turned SEGMENT_BEND of the
 * angle, so the length is the same at every bend; only the chord shortens.
 */
export function bendPoints(angle: number, length: number, out: Float64Array): Float64Array {
  const seg = length / SEGMENTS;
  let x = 0;
  let y = 0;
  out[0] = 0;
  out[1] = 0;
  for (let k = 0; k < SEGMENTS; k++) {
    const a = angle * SEGMENT_BEND[k];
    x += seg * Math.sin(a);
    y += seg * Math.cos(a);
    out[2 * k + 2] = x;
    out[2 * k + 3] = y;
  }
  return out;
}

// --- Palettes ---------------------------------------------------------------

export type FieldId = "meadow" | "wheat" | "dry" | "lavender";
export type SunId = "midday" | "golden" | "overcast";

export interface FieldPalette {
  /** Shadowed root and ground colour. */
  root: Rgb;
  /** Blade colour range. */
  a: Rgb;
  b: Rgb;
  /** Lighter underside, shown as blades bend. */
  under: Rgb;
  /** Seed head colour. */
  head: Rgb;
  /** Share of blades with a seed head, and the head's width relative to the blade. */
  headShare: number;
  headWidth: number;
}

const field = (
  root: string,
  a: string,
  b: string,
  under: string,
  head: string,
  headShare: number,
  headWidth: number,
): FieldPalette => ({
  root: hexToUnitRgb(root),
  a: hexToUnitRgb(a),
  b: hexToUnitRgb(b),
  under: hexToUnitRgb(under),
  head: hexToUnitRgb(head),
  headShare,
  headWidth,
});

export const FIELDS: Record<FieldId, FieldPalette> = {
  meadow: field("#1e3214", "#3f7429", "#86a33f", "#b5cf7c", "#d6d0a2", 0.15, 1.2),
  wheat: field("#584622", "#c39443", "#dfbd6c", "#f2dfa8", "#d8a64c", 0.85, 2),
  dry: field("#463a24", "#9c8656", "#c6b07f", "#e0d4ae", "#e6d9bd", 0.35, 1.3),
  lavender: field("#22311d", "#4b673c", "#788a55", "#adbb95", "#8a6dc0", 0.7, 1.6),
};

export interface SunPalette {
  zenith: Rgb;
  horizon: Rgb;
  /** Light on the field (multiplies blade colours). */
  light: Rgb;
  /** Sun glow colour, and its strength in the sky and as backlight on blade edges. */
  glow: Rgb;
  glowSky: number;
  backlight: number;
  /** Aerial haze the far field fades into. */
  haze: Rgb;
  /** Sun position as fractions of the width, and of the sky height above the horizon (1 = top). */
  sunX: number;
  sunY: number;
  /** Sun disc visibility, 0..1. */
  disc: number;
  /** Cloud cover 0..1, and lit and shaded cloud colours. */
  cover: number;
  cloud: Rgb;
  shade: Rgb;
}

const sun = (
  zenith: string,
  horizon: string,
  light: string,
  glow: string,
  glowSky: number,
  backlight: number,
  haze: string,
  sunX: number,
  sunY: number,
  disc: number,
  cover: number,
  cloud: string,
  shade: string,
): SunPalette => ({
  zenith: hexToUnitRgb(zenith),
  horizon: hexToUnitRgb(horizon),
  light: hexToUnitRgb(light),
  glow: hexToUnitRgb(glow),
  glowSky,
  backlight,
  haze: hexToUnitRgb(haze),
  sunX,
  sunY,
  disc,
  cover,
  cloud: hexToUnitRgb(cloud),
  shade: hexToUnitRgb(shade),
});

export const SUNS: Record<SunId, SunPalette> = {
  midday: sun(
    "#3d7bcc",
    "#bcd7ec",
    "#ffffff",
    "#fff4d6",
    0.25,
    0.12,
    "#c8dbe9",
    0.78,
    1.25,
    0,
    0.35,
    "#ffffff",
    "#b7c4d4",
  ),
  golden: sun(
    "#476ca9",
    "#ffc488",
    "#ffd9aa",
    "#ffad55",
    0.9,
    0.55,
    "#efbf8f",
    0.76,
    0.12,
    1,
    0.3,
    "#ffd1a0",
    "#8d7d93",
  ),
  overcast: sun(
    "#8b96a2",
    "#c8ccd0",
    "#b9bfc5",
    "#e6e6e2",
    0.1,
    0.04,
    "#c3c8cc",
    0.6,
    0.8,
    0,
    0.8,
    "#d5d8db",
    "#98a0a9",
  ),
};
