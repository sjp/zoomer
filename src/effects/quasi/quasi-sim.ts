/**
 * Pure logic for the Quasicrystal effect, shared by `quasi.ts` and its tests:
 * the wave directions, the wrapped phase, the wavelength clamp, the analytic
 * anti-aliasing factor, the pattern's centre, the tone curve and the palettes.
 *
 * The pattern is `v(p) = (1/n) Σ_k cos(f dot(p - c, d_k) + φ)` over `n` unit
 * directions `d_k` at angles `π k / n`. Every term has the same spatial frequency
 * `f`, so the sum has no finer detail than one wave; the soft tone curve adds only
 * gentle harmonics.
 */
import { hexToUnitRgb, type Rgb } from "../color";
import { clamp, wrap } from "../math";

export const TAU = 2 * Math.PI;

/** Wave set counts offered by the `symmetry` param. */
export const SYMMETRIES = [5, 7, 9, 11] as const;
export const MAX_WAVES = 11;

/** Wave count for a `symmetry` select value; 7 for an unknown value. */
export function waveCount(name: string): number {
  const n = Number(name);
  return (SYMMETRIES as readonly number[]).includes(n) ? n : 7;
}

/**
 * Writes the `n` unit directions at angles `π k / n` to `out` as (x, y) pairs and
 * returns it.
 */
export function writeDirections(n: number, out: Float64Array): Float64Array {
  for (let k = 0; k < n; k++) {
    const a = (Math.PI * k) / n;
    out[2 * k] = Math.cos(a);
    out[2 * k + 1] = Math.sin(a);
  }
  return out;
}

/** Radians of phase per second at speed 1: one full breath in about 21 s. */
const PHASE_RATE = 0.3;

/**
 * Advances the shared wave phase by `dt` seconds at `speed` (negative reverses the
 * flow) and wraps it to [0, 2π). Every term is periodic in the phase, so wrapping
 * never changes the pattern.
 */
export function advancePhase(phase: number, dt: number, speed: number): number {
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const v = Number.isFinite(speed) ? speed : 0;
  const p = Number.isFinite(phase) ? phase : 0;
  return wrap(p + d * v * PHASE_RATE, 0, TAU);
}

/** `scale` param range: wavelength in px at 1080p. */
export const MIN_SCALE = 40;
export const MAX_SCALE = 260;
/**
 * Floor on the wavelength in device px, whatever the resolution. The tone curve's
 * third harmonic then stays above 5 px, so nothing aliases or shimmers.
 */
export const MIN_WAVELENGTH_PX = 16;

/**
 * Wavelength in device px for a `scale` param (px at 1080p) at `viewScale`
 * (height / 1080): the param clamped to its range and scaled, but never below
 * MIN_WAVELENGTH_PX.
 */
export function wavelengthPx(scale: number, viewScale: number): number {
  const s = Number.isFinite(scale) ? clamp(scale, MIN_SCALE, MAX_SCALE) : MIN_SCALE;
  const k = Number.isFinite(viewScale) && viewScale > 0 ? viewScale : 1;
  return Math.max(s * k, MIN_WAVELENGTH_PX);
}

/**
 * Amplitude left on a cosine of wavelength `lambda` px after a one-pixel box
 * filter: sinc(π / lambda). The frequency is the same everywhere on screen, so this
 * is the exact pixel-footprint low-pass (what `fwidth` would estimate per pixel).
 */
export function footprintGain(lambda: number): number {
  const x = Math.PI / Math.max(lambda, 1);
  return Math.sin(x) / x;
}

/** Centre modes of the `centre` param. */
export const CENTRES = ["centre", "offcentre", "drifting"] as const;
export type CentreName = (typeof CENTRES)[number];

/** Centre mode index for a name; Off-centre for an unknown name. */
export function centreIndex(name: string): number {
  const i = (CENTRES as readonly string[]).indexOf(name);
  return i < 0 ? 1 : i;
}

/** Off-centre rest point, frame heights from the frame centre (y up): upper left, clear of the speaker. */
const OFF_CENTRE: readonly [number, number] = [-0.58, 0.2];
/** Drifting: Lissajous amplitude in frame heights, and seconds per cycle. */
const DRIFT_AMP: readonly [number, number] = [0.55, 0.28];
const DRIFT_PERIOD = 240;

/** Advances the drift phase (cycles, in [0, 1)) by `dt` seconds. */
export function advanceDrift(phase: number, dt: number): number {
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const p = Number.isFinite(phase) ? phase : 0;
  return wrap(p + d / DRIFT_PERIOD, 0, 1);
}

/**
 * Writes the pattern centre for centre mode `mode` (a CENTRES index) and drift
 * phase `drift` (cycles) to `out`, in frame heights from the frame centre (y up).
 * Smooth in the phase, with period 1.
 */
export function centreOffset(mode: number, drift: number, out: Float64Array): Float64Array {
  if (mode === 0) {
    out[0] = 0;
    out[1] = 0;
  } else if (mode === 2) {
    const a = TAU * drift;
    out[0] = DRIFT_AMP[0] * Math.sin(a);
    out[1] = DRIFT_AMP[1] * Math.sin(2 * a + 1);
  } else {
    out[0] = OFF_CENTRE[0];
    out[1] = OFF_CENTRE[1];
  }
  return out;
}

/**
 * Packs wave `k` for the shader as (fx, fy, offset) at `out[3 k]`: the direction
 * times the angular frequency `f` (radians per device px), and `φ - f dot(c, d_k)`
 * wrapped to [0, 2π), so the shader evaluates `cos(dot(px, (fx, fy)) + offset)`.
 * `dirs` comes from writeDirections, `cx`, `cy` are the centre in device px.
 */
export function writeWaves(
  dirs: Float64Array,
  n: number,
  f: number,
  phase: number,
  cx: number,
  cy: number,
  out: Float32Array,
): void {
  for (let k = 0; k < n; k++) {
    const dx = dirs[2 * k];
    const dy = dirs[2 * k + 1];
    out[3 * k] = dx * f;
    out[3 * k + 1] = dy * f;
    out[3 * k + 2] = wrap(phase - f * (cx * dx + cy * dy), 0, TAU);
  }
}

/** The pattern value at device px (x, y), in [-1, 1], as the shader computes it. */
export function patternValue(waves: Float32Array, n: number, x: number, y: number): number {
  let s = 0;
  for (let k = 0; k < n; k++) {
    s += Math.cos(x * waves[3 * k] + y * waves[3 * k + 1] + waves[3 * k + 2]);
  }
  return s / n;
}

/**
 * Tone curve gain on `v * sqrt(n)`: the sum of n unit cosines has a standard
 * deviation of about sqrt(n / 2), so this keeps the look alike at every symmetry.
 */
const TONE_GAIN = 1.6;

/** Gain the shader applies to the raw sum Σ cos, for `n` waves and an amplitude factor `amp`. */
export function toneScale(n: number, amp: number): number {
  return (TONE_GAIN * amp) / Math.sqrt(n);
}

/**
 * Soft tone curve: maps a pattern value `v` in [-1, 1] to a palette position in
 * (0, 1) via the saturating `g / sqrt(1 + g^2)`, then shrinks it towards 0.5 by
 * `contrast` (0–1).
 */
export function tone(v: number, n: number, contrast: number): number {
  const g = v * n * toneScale(n, 1);
  return 0.5 + 0.5 * clamp(contrast, 0, 1) * (g / Math.sqrt(1 + g * g));
}

/** Palettes: four colour stops from the troughs to the crests. */
export const PALETTES = {
  pastel: ["#a9b8de", "#d5c4e4", "#f2d6d2", "#faf0de"],
  jewel: ["#070a1c", "#173270", "#5c2172", "#1f8e7e"],
  mono: ["#16181c", "#3a3e46", "#7d828c", "#c8ccd2"],
  sunset: ["#2a1236", "#7a2a4e", "#d0604a", "#f4b26a"],
} as const satisfies Record<string, readonly [string, string, string, string]>;
export type PaletteName = keyof typeof PALETTES;
export const PALETTE_STOPS = 4;

const PALETTE_DATA = new Map<string, Float32Array>();

const isPaletteName = (name: string): name is PaletteName => Object.hasOwn(PALETTES, name);

/** The named palette's stops as 4 packed unit-RGB vec3s, built once; Pastel for an unknown name. */
export function paletteData(name: string): Float32Array {
  const key: PaletteName = isPaletteName(name) ? name : "pastel";
  let d = PALETTE_DATA.get(key);
  if (!d) {
    d = new Float32Array(3 * PALETTE_STOPS);
    const stops = PALETTES[key];
    for (let i = 0; i < PALETTE_STOPS; i++) {
      d.set(hexToUnitRgb(stops[i]), 3 * i);
    }
    PALETTE_DATA.set(key, d);
  }
  return d;
}

/**
 * The palette colour at `t` in [0, 1]: piecewise linear through the stops, as the
 * shader's mix chain evaluates it. Writes to `out` and returns it.
 */
export function paletteColor(data: Float32Array, t: number, out: Rgb): Rgb {
  const x = clamp(t, 0, 1) * (PALETTE_STOPS - 1);
  for (let c = 0; c < 3; c++) {
    let v = data[c];
    for (let i = 1; i < PALETTE_STOPS; i++) {
      const w = clamp(x - (i - 1), 0, 1);
      v += (data[3 * i + c] - v) * w;
    }
    out[c] = v;
  }
  return out;
}
