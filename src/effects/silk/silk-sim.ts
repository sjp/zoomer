/**
 * Pure maths for the silk drapery effect: the per-layout wave sets, phase
 * advance, the uniform arrays the shader reads, and a JS twin of the shader's
 * height field and its analytic gradient (for tests).
 *
 * Positions are in frame-height units, centred on the canvas, y up: the frame is
 * `aspect` wide and 1 tall. The fabric is a height field
 *
 *   h(p) = sum_i a_i sin(k_i . q + phi_i),   q = p + W(p),
 *
 * where W is a low-frequency two-wave domain warp that bends the folds so they
 * aren't perfectly regular. The gradient is exact: grad_p h = J^T grad_q h, with
 * J = I + dW/dp.
 */
import { wrap } from "../math";
import { MIN_FOLDS, MAX_FOLDS } from "./silk.meta";

const TAU = Math.PI * 2;

export const SILK_LAYOUTS = ["hanging", "flowing", "billowing"] as const;
type SilkLayout = (typeof SILK_LAYOUTS)[number];

/** Waves in the height sum, and warp waves. The shader's arrays have these sizes. */
export const WAVES = 6;
export const WARPS = 2;
/** Floats per wave in the uniform arrays: (kx, ky, phase, amplitude). */
export const WAVE_FLOATS = 4;

/** Folds are counted across a 16:9 frame whatever the canvas shape, so the cloth doesn't rescale with aspect. */
export const REF_ASPECT = 16 / 9;

/**
 * The warp's amplitude as a fraction of the base wavelength: enough to bend the
 * folds visibly, small enough that the warp never folds space over (|dW/dp| < 1,
 * checked in silk-sim.test.ts).
 */
export const WARP_K = 0.25;

interface WaveSpec {
  /** Direction of the wave vector, degrees (0 = varies along x, so folds run vertically; y up). */
  angle: number;
  /** Wavelength as a multiple of the base wavelength (`baseWavelength`). */
  length: number;
  /** Relative amplitude; each layout's amplitudes are normalised to sum to 1. */
  amp: number;
  /** Seconds per cycle at breeze 1; the sign sets the direction of travel. */
  period: number;
  /** Starting phase, radians. */
  phase: number;
}

interface WarpSpec {
  angle: number;
  /** Wavelength in frame-height units (absolute, so the bend is the same at every fold count). */
  length: number;
  period: number;
  phase: number;
}

/** Normalises amplitudes so they sum to 1, keeping |h| <= 1. */
function normalised(specs: readonly WaveSpec[]): readonly WaveSpec[] {
  const sum = specs.reduce((s, w) => s + Math.abs(w.amp), 0);
  return specs.map((w) => ({ ...w, amp: w.amp / sum }));
}

/**
 * Wave sets per layout. The first wave is the dominant fold direction: the
 * thread tangent for the anisotropic sheen runs along its wave vector, across
 * the folds, so highlights stretch along the crests. Pairs travelling in
 * opposite directions make the folds sway rather than only scroll.
 */
export const LAYOUT_WAVES: Readonly<Record<SilkLayout, readonly WaveSpec[]>> = {
  // Mostly vertical folds, like a curtain, with a slow vertical swell.
  hanging: normalised([
    { angle: 0, length: 1, amp: 1, period: 14, phase: 0 },
    { angle: 6, length: 0.63, amp: 0.5, period: -10, phase: 1.3 },
    { angle: -5, length: 1.7, amp: 0.6, period: 19, phase: 2.1 },
    { angle: 82, length: 4.5, amp: 0.25, period: 23, phase: 0.7 },
    { angle: -9, length: 0.55, amp: 0.22, period: -8, phase: 4 },
    { angle: 14, length: 2.6, amp: 0.3, period: -27, phase: 5.2 },
  ]),
  // Long diagonal waves, like a scarf in the wind.
  flowing: normalised([
    { angle: 35, length: 1.2, amp: 1, period: 12, phase: 0.4 },
    { angle: 42, length: 0.7, amp: 0.45, period: -9, phase: 2.6 },
    { angle: 28, length: 2.2, amp: 0.6, period: 17, phase: 1.1 },
    { angle: 125, length: 3.5, amp: 0.3, period: 21, phase: 3.7 },
    { angle: 38, length: 0.55, amp: 0.2, period: 7.5, phase: 5.5 },
    { angle: 20, length: 1.6, amp: 0.35, period: -15, phase: 0.9 },
  ]),
  // Broader, rounder swells from crossing waves.
  billowing: normalised([
    { angle: 10, length: 1.8, amp: 1, period: 16, phase: 0 },
    { angle: 95, length: 2, amp: 0.85, period: -19, phase: 1.9 },
    { angle: 50, length: 1.3, amp: 0.45, period: 12, phase: 3.3 },
    { angle: -40, length: 1.5, amp: 0.45, period: -14, phase: 4.4 },
    { angle: 20, length: 0.8, amp: 0.2, period: 9, phase: 0.6 },
    { angle: 120, length: 0.9, amp: 0.2, period: -11, phase: 2.8 },
  ]),
};

export const WARP_WAVES: readonly WarpSpec[] = [
  { angle: 30, length: 1.7, period: 31, phase: 0.5 },
  { angle: 115, length: 2.3, period: -37, phase: 2.2 },
];

/** The wave set for a layout name; unknown names fall back to "hanging". */
export function layoutWaves(layout: string): readonly WaveSpec[] {
  return (
    (LAYOUT_WAVES as Record<string, readonly WaveSpec[] | undefined>)[layout] ??
    LAYOUT_WAVES.hanging
  );
}

/** Base wavelength in frame-height units for `folds` across a 16:9 frame (clamped to the slider range). */
export function baseWavelength(folds: number): number {
  const n = Math.min(Math.max(Number.isFinite(folds) ? folds : MIN_FOLDS, MIN_FOLDS), MAX_FOLDS);
  return REF_ASPECT / n;
}

/**
 * Advances each phase by one cycle per `period` seconds of `dt` (already scaled
 * by the breeze), wrapped into [-pi, pi) so the float32 uniform stays precise.
 * The wrap is by whole cycles, so sin and cos are continuous across it.
 */
export function advancePhases(
  phases: Float64Array,
  specs: readonly { period: number }[],
  dt: number,
): void {
  for (let i = 0; i < specs.length; i++) {
    phases[i] = wrap(phases[i] + (TAU * dt) / specs[i].period, -Math.PI, TAU);
  }
}

/**
 * Fills `out` (WAVES * 4 floats) with each wave's (kx, ky, phase, amp) for
 * `folds`, adding each spec's starting phase to the running phase.
 */
export function fillWaveUniforms(
  out: Float32Array,
  specs: readonly WaveSpec[],
  folds: number,
  phases: Float64Array,
): void {
  const base = baseWavelength(folds);
  for (let i = 0; i < WAVES; i++) {
    const s = specs[i];
    const k = TAU / (s.length * base);
    const a = (s.angle * Math.PI) / 180;
    const o = i * WAVE_FLOATS;
    out[o] = k * Math.cos(a);
    out[o + 1] = k * Math.sin(a);
    out[o + 2] = wrap(phases[i] + s.phase, -Math.PI, TAU);
    out[o + 3] = s.amp;
  }
}

/** Fills `out` (WARPS * 4 floats) with each warp wave's (gx, gy, phase, amplitude) for `folds`. */
export function fillWarpUniforms(out: Float32Array, folds: number, phases: Float64Array): void {
  const amp = WARP_K * baseWavelength(folds);
  for (let i = 0; i < WARPS; i++) {
    const s = WARP_WAVES[i];
    const k = TAU / s.length;
    const a = (s.angle * Math.PI) / 180;
    const o = i * WAVE_FLOATS;
    out[o] = k * Math.cos(a);
    out[o + 1] = k * Math.sin(a);
    out[o + 2] = wrap(phases[i] + s.phase, -Math.PI, TAU);
    out[o + 3] = amp;
  }
}

/**
 * Gradient-to-slope factor for `depth`: the slope is grad h times this, so a
 * lone base wave of amplitude 1 has a peak slope of `SLOPE_GAIN * depth`.
 */
const SLOPE_GAIN = 1.6;
export function slopeScale(folds: number, depth: number): number {
  return (Math.max(0, depth) * SLOPE_GAIN * baseWavelength(folds)) / TAU;
}

export interface SilkSample {
  h: number;
  gx: number;
  gy: number;
}

/**
 * JS twin of the shader's height field: h and its analytic gradient at (x, y),
 * from the arrays `fillWaveUniforms` and `fillWarpUniforms` produce.
 */
export function silkField(
  waves: ArrayLike<number>,
  warp: ArrayLike<number>,
  x: number,
  y: number,
  out: SilkSample,
): SilkSample {
  const w0 = warp[0] * x + warp[1] * y + warp[2];
  const w1 = warp[4] * x + warp[5] * y + warp[6];
  const qx = x + warp[3] * Math.sin(w0);
  const qy = y + warp[7] * Math.sin(w1);
  let h = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < WAVES; i++) {
    const o = i * WAVE_FLOATS;
    const th = waves[o] * qx + waves[o + 1] * qy + waves[o + 2];
    const a = waves[o + 3];
    h += a * Math.sin(th);
    const c = a * Math.cos(th);
    sx += c * waves[o];
    sy += c * waves[o + 1];
  }
  // grad_p h = J^T grad_q h, J = I + dW/dp.
  const c0 = warp[3] * Math.cos(w0) * sx;
  const c1 = warp[7] * Math.cos(w1) * sy;
  out.h = h;
  out.gx = sx + c0 * warp[0] + c1 * warp[4];
  out.gy = sy + c0 * warp[1] + c1 * warp[5];
  return out;
}

/** Light elevation above the cloth, radians. */
const LIGHT_ELEVATION = (40 * Math.PI) / 180;

/**
 * Light direction L and Blinn half vector H (view straight on, V = +z) for a
 * light at `angleDeg` in the screen plane (0 = from the right, 90 = from the
 * top), at `LIGHT_ELEVATION`. Writes six floats: L then H.
 */
export function lightVectors(out: Float32Array | number[], angleDeg: number): void {
  const a = (angleDeg * Math.PI) / 180;
  const ce = Math.cos(LIGHT_ELEVATION);
  const lx = Math.cos(a) * ce;
  const ly = Math.sin(a) * ce;
  const lz = Math.sin(LIGHT_ELEVATION);
  const hz = lz + 1;
  const n = Math.hypot(lx, ly, hz);
  out[0] = lx;
  out[1] = ly;
  out[2] = lz;
  out[3] = lx / n;
  out[4] = ly / n;
  out[5] = hz / n;
}
