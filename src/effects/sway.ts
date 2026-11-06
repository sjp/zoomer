/**
 * The sway-with-lag model shared by the swaying-plant effects (kelp, blossom
 * branch, greenhouse leaves, aquarium plants), in JS and GLSL twins.
 *
 * - A **swell** is a sum of a few slow sines in a **phase** that runs 0..1 over one
 *   `period` (seconds at speed 1). Every wave makes a whole number of cycles per
 *   period, so the phase wraps at 1 without a jump and can be uploaded as a small
 *   float (never unbounded time). `swellAt` is normalised to [-1, 1].
 * - **Lag** delays the swell by a number of seconds (at speed 1): a point further
 *   from the anchor reads the swell from a moment earlier, so it trails the base.
 * - `swayOffset` is the bend of a stem at height `t` (0 at the base, 1 at the tip):
 *   `amplitude * swell(phase - lag * t) * t^2`, zero at the base and bounded by
 *   `amplitude`. Effects that rotate segments instead (a branch by tree depth) use
 *   `swayAt` with a lag per depth.
 *
 * Typical use:
 *
 * ```ts
 * const SWELL = createSwell(60, [{ cycles: 6, amplitude: 1, offset: 0 }, ...]);
 * // frame:
 * phase = advanceSwell(SWELL, phase, dt, speed);
 * u.f1("uSwayPhase", phase);
 * // shader: ${swayGlsl(SWELL)} ... swayOffset(uSwayPhase + frondOffset, t, lag)
 * ```
 */
import { glslFloat } from "./gl";
import { fract } from "./math";

/** One sine of a swell. */
export interface SwellWave {
  /** Whole cycles per swell period (a positive integer). */
  readonly cycles: number;
  /** Relative weight; the swell is normalised by the sum of their absolute values. */
  readonly amplitude: number;
  /** Phase offset in cycles (0..1). */
  readonly offset: number;
}

export interface Swell {
  /** Seconds per phase cycle at speed 1. */
  readonly period: number;
  readonly waves: readonly SwellWave[];
  /** `1 / sum(|amplitude|)`, so `swellAt` stays within [-1, 1]. */
  readonly norm: number;
}

const TAU = Math.PI * 2;

/**
 * Builds a swell. Throws unless `period` is positive and every wave has a
 * positive whole number of cycles, which is what lets the phase wrap seamlessly.
 */
export function createSwell(period: number, waves: readonly SwellWave[]): Swell {
  if (!(period > 0) || !Number.isFinite(period)) {
    throw new Error(`createSwell: period must be positive, got ${String(period)}`);
  }
  if (waves.length === 0) throw new Error("createSwell: needs at least one wave");
  let sum = 0;
  for (const w of waves) {
    if (!Number.isInteger(w.cycles) || w.cycles < 1) {
      throw new Error(`createSwell: cycles must be a positive integer, got ${String(w.cycles)}`);
    }
    sum += Math.abs(w.amplitude);
  }
  if (!(sum > 0)) throw new Error("createSwell: the waves' amplitudes sum to zero");
  return { period, waves, norm: 1 / sum };
}

/**
 * A general-purpose slow swell: dominant period 10 s, a 12 s partner and a faint
 * 5.5 s ripple, repeating every 60 s. Effects may define their own.
 */
export const DEFAULT_SWELL: Swell = createSwell(60, [
  { cycles: 6, amplitude: 1, offset: 0 },
  { cycles: 5, amplitude: 0.6, offset: 0.31 },
  { cycles: 11, amplitude: 0.22, offset: 0.67 },
]);

/**
 * Advances a swell phase by `dt` seconds at `speed` (1 = real time), wrapped to
 * [0, 1). Negative or non-finite steps leave the phase where it is.
 */
export function advanceSwell(swell: Swell, phase: number, dt: number, speed = 1): number {
  const step = (dt * speed) / swell.period;
  return Number.isFinite(step) && step > 0 ? fract(phase + step) : fract(phase);
}

/** The swell at `phase` (any real; periodic with period 1), in [-1, 1]. */
export function swellAt(swell: Swell, phase: number): number {
  let s = 0;
  for (const w of swell.waves)
    s += w.amplitude * Math.sin(TAU * fract(w.cycles * phase + w.offset));
  return s * swell.norm;
}

/** The swell read `lag` seconds (at speed 1) in the past, in [-1, 1]. */
export function swayAt(swell: Swell, phase: number, lag: number): number {
  return swellAt(swell, phase - lag / swell.period);
}

/**
 * Horizontal bend of a stem at height `t` (clamped to [0, 1]; 0 = base, 1 = tip),
 * whose tip lags the base by `lag` seconds: `amplitude * swell(phase - lag t) t^2`.
 * Zero at the base, continuous in phase and `t`, and `|result| <= |amplitude|`.
 */
export function swayOffset(
  swell: Swell,
  phase: number,
  t: number,
  lag: number,
  amplitude = 1,
): number {
  const u = Math.min(1, Math.max(0, t));
  return amplitude * swayAt(swell, phase, lag * u) * u * u;
}

/**
 * GLSL twins of `swellAt`, `swayAt` and `swayOffset` (unit amplitude) for this
 * swell, with its constants baked in:
 *
 * - `float <name>Swell(float phase)`
 * - `float <name>At(float phase, float lag)`, lag in seconds
 * - `float <name>Offset(float phase, float t, float lag)`, t clamped to [0, 1]
 *
 * `name` defaults to "sway", so a shader can hold more than one swell.
 */
export function swayGlsl(swell: Swell, name = "sway"): string {
  const f = glslFloat;
  const terms = swell.waves
    .map(
      (w) => `${f(w.amplitude)} * sin(${f(TAU)} * fract(${f(w.cycles)} * phase + ${f(w.offset)}))`,
    )
    .join("\n    + ");
  return /* glsl */ `
float ${name}Swell(float phase) {
  return ${f(swell.norm)} * (${terms});
}
float ${name}At(float phase, float lag) {
  return ${name}Swell(phase - lag * ${f(1 / swell.period)});
}
float ${name}Offset(float phase, float t, float lag) {
  float u = clamp(t, 0.0, 1.0);
  return ${name}At(phase, lag * u) * u * u;
}
`;
}
