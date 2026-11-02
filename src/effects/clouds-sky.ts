/**
 * Pure (GL-free) building blocks for the time-lapse clouds effect: the tileable
 * noise texture, the per-layer motion uniforms, the time-of-day preset table and
 * the smooth preset transition.
 */

import { hexToUnitRgb } from "./color";
import type { NoiseChannel } from "./noise";
import { fract } from "./math";

// ---------------------------------------------------------------------------
// Noise texture
// ---------------------------------------------------------------------------

/**
 * Lattice periods (cells per texture side) of the four channels. Each channel is
 * one octave of tileable gradient noise, so one bilinear fetch of the texture
 * yields four octaves, combined in the shader with weights 1/2, 1/4, 1/8, 1/16.
 */
export const NOISE_PERIODS = [4, 8, 16, 32] as const;

/**
 * Channels of the clouds' RGBA8 noise texture, for `buildPeriodicNoiseTexture`:
 * decorrelated octaves at `NOISE_PERIODS`, each with its own permutation. The
 * texture size should be a multiple of 32 so every octave's cells span whole texels.
 */
export function cloudNoiseChannels(seed: number): NoiseChannel[] {
  return NOISE_PERIODS.map((period, c) => ({ period, seed: seed * 31 + c * 977 + 1 }));
}

// ---------------------------------------------------------------------------
// Layer motion and coverage
// ---------------------------------------------------------------------------

/** Detail fetch frequency relative to the coarse one (non-integer to avoid lockstep). */
const DETAIL_MUL = 4.37;
/** The detail octaves drift a little faster than the bulk, so edges churn. */
const DETAIL_DRIFT = 1.2;
/** Horizontal squash of cloud space, so clouds are wider than tall. */
export const STRETCH_X = 0.6;
/** Seconds (at speed 1) per evolution cross-fade cycle. */
const EVOLVE_PERIOD = 28;
/** Texture units each evolving sample slides (upwards) over one cycle. */
const MORPH = 0.06;

/**
 * Half-width, in A-weight, of the window around the A/B swap where the lighting
 * cross-fades between the two samples' gradients instead of jumping.
 */
export const LIGHT_BLEND = 0.1;

/**
 * Weight of sample A's gradient in the lighting. The light sample comes from the
 * higher-weighted sample only (1 or 0), except within `LIGHT_BLEND` of the swap at
 * `wa` = 0.5, where it ramps linearly so the shading never jumps. The shader skips
 * the fetch of a sample whose light weight is 0.
 */
export function lightWeight(wa: number): number {
  return Math.min(1, Math.max(0, (wa - 0.5) / (2 * LIGHT_BLEND) + 0.5));
}

/** Floats per layer in each of the three per-layer uniform arrays. */
export const LAYER_FLOATS = 4;

/** Cheap deterministic hash of a number to [0, 1). */
const hash = (k: number) => fract(Math.sin(k * 12.9898 + 4.1414) * 43758.5453);

/**
 * Computes one layer's uniforms (writing 4 floats at `o` in each array).
 *
 * - `drift`: accumulated wind travel in frame heights (float64, unbounded).
 * - `evolve`: accumulated evolution time in seconds.
 * - `freq`: coarse texture repeats per frame height.
 *
 * The shape evolves by cross-fading two samples A and B of the noise, each at a
 * random offset that slides slowly and re-randomises once per cycle while its
 * weight is exactly 0, so there is never a visible jump. The cycles are half a
 * period apart, and the weights (triangle waves) always sum to 1. Offsets are
 * wrapped to [0, 1) since the texture tiles, keeping float32 uniforms precise.
 * Allocates nothing.
 */
export function layerUniforms(
  offA: Float32Array,
  detail: Float32Array,
  params: Float32Array,
  o: number,
  layer: number,
  drift: number,
  evolve: number,
  freq: number,
  opacity: number,
): void {
  const dx = -drift * STRETCH_X * freq;
  const phase = evolve / EVOLVE_PERIOD + layer * 0.31;
  const phaseB = phase + 0.5;
  const ka = Math.floor(phase);
  const kb = Math.floor(phaseB);
  const fa = phase - ka;
  const fb = phaseB - kb;
  const seedA = ka * 2 + layer * 1013;
  const seedB = kb * 2 + 1 + layer * 1013;
  offA[o] = fract(dx + hash(seedA));
  offA[o + 1] = fract(hash(seedA + 0.5) - MORPH * fa);
  offA[o + 2] = fract(dx + hash(seedB));
  offA[o + 3] = fract(hash(seedB + 0.5) - MORPH * fb);
  const dfreq = freq * DETAIL_MUL;
  detail[o] = fract(-drift * DETAIL_DRIFT * STRETCH_X * dfreq + layer * 0.37);
  detail[o + 1] = fract(layer * 0.61);
  detail[o + 2] = dfreq;
  const wa = 1 - Math.abs(2 * fa - 1);
  const wb = 1 - wa;
  detail[o + 3] = lightWeight(wa);
  params[o] = freq;
  params[o + 1] = wa;
  // Averaging two independent fields lowers their contrast by sqrt(wa² + wb²).
  params[o + 2] = 1 / Math.sqrt(wa * wa + wb * wb);
  params[o + 3] = opacity;
}

/** Density threshold (in unit-variance noise) for a coverage of 0..1. */
export function coverageThreshold(coverage: number): number {
  const c = Math.min(1, Math.max(0, coverage));
  return 2.3 - 3.6 * c;
}

// ---------------------------------------------------------------------------
// Time-of-day presets
// ---------------------------------------------------------------------------

export interface SkyPreset {
  skyTop: string;
  skyBottom: string;
  /** Sunlit side of the clouds. */
  cloudLight: string;
  /** Shadowed side / bases of the clouds. */
  cloudShadow: string;
  /** Sun or moon glow colour (also tints clouds near it). */
  glow: string;
  /** Sun or moon position in uv (0..1, origin bottom-left; may be off-screen). */
  sunX: number;
  sunY: number;
  /** Glow falloff radius, in frame heights. */
  glowRadius: number;
  glowStrength: number;
  /** Visible sun/moon disc radius in frame heights, and its strength (0 = none). */
  discRadius: number;
  discStrength: number;
  /** Direction towards the light in the cloud plane (y up); normalised when built. */
  lightX: number;
  lightY: number;
}

export const TIME_OPTIONS = [
  { value: "day", label: "Day" },
  { value: "golden", label: "Golden hour" },
  { value: "dusk", label: "Dusk" },
  { value: "night", label: "Night (moonlit)" },
] as const;

export type TimeOfDay = (typeof TIME_OPTIONS)[number]["value"];

export const PRESETS: Readonly<Record<TimeOfDay, SkyPreset>> = {
  day: {
    skyTop: "#2a66c0",
    skyBottom: "#a8cdef",
    cloudLight: "#ffffff",
    cloudShadow: "#8e9db4",
    glow: "#fff4dc",
    sunX: 0.8,
    sunY: 1.15,
    glowRadius: 0.45,
    glowStrength: 0.22,
    discRadius: 0.03,
    discStrength: 0,
    lightX: 0.25,
    lightY: 1,
  },
  golden: {
    skyTop: "#4a6ea6",
    skyBottom: "#ffc287",
    cloudLight: "#ffe0ad",
    cloudShadow: "#7a6580",
    glow: "#ffb25a",
    sunX: 0.74,
    sunY: 0.12,
    glowRadius: 0.32,
    glowStrength: 0.75,
    discRadius: 0.035,
    discStrength: 0.9,
    lightX: 0.8,
    lightY: 0.45,
  },
  dusk: {
    skyTop: "#1c2250",
    skyBottom: "#dc7458",
    cloudLight: "#ff9c78",
    cloudShadow: "#382a4c",
    glow: "#ff7843",
    sunX: 0.62,
    sunY: -0.04,
    glowRadius: 0.3,
    glowStrength: 0.6,
    discRadius: 0.035,
    discStrength: 0,
    // The sun is below the horizon, so the cloud bases catch the light.
    lightX: 0.45,
    lightY: -0.6,
  },
  night: {
    skyTop: "#050a1c",
    skyBottom: "#1b2948",
    cloudLight: "#a6b4d2",
    cloudShadow: "#0e1529",
    glow: "#9fb2df",
    sunX: 0.24,
    sunY: 0.78,
    glowRadius: 0.16,
    glowStrength: 0.28,
    discRadius: 0.022,
    discStrength: 0.9,
    lightX: -0.35,
    lightY: 0.7,
  },
};

/** Float offsets of each field within one preset row of the table. */
export const P = {
  skyTop: 0,
  skyBottom: 3,
  cloudLight: 6,
  cloudShadow: 9,
  glow: 12,
  sunX: 15,
  sunY: 16,
  glowRadius: 17,
  glowStrength: 18,
  discRadius: 19,
  discStrength: 20,
  lightX: 21,
  lightY: 22,
} as const;

/** Floats per preset row. */
export const PRESET_STRIDE = 23;

/** Row index of a `time` param value; unknown values fall back to "day" (0). */
export function presetIndex(time: string): number {
  const i = TIME_OPTIONS.findIndex((o) => o.value === time);
  return i < 0 ? 0 : i;
}

/**
 * Flattens presets (in `TIME_OPTIONS` order) into one Float32Array of
 * `PRESET_STRIDE` floats per row: colours as 0..1 RGB, light direction normalised.
 */
export function buildPresetTable(presets: Readonly<Record<TimeOfDay, SkyPreset>> = PRESETS) {
  const table = new Float32Array(TIME_OPTIONS.length * PRESET_STRIDE);
  TIME_OPTIONS.forEach(({ value }, i) => {
    const p = presets[value];
    const o = i * PRESET_STRIDE;
    table.set(hexToUnitRgb(p.skyTop), o + P.skyTop);
    table.set(hexToUnitRgb(p.skyBottom), o + P.skyBottom);
    table.set(hexToUnitRgb(p.cloudLight), o + P.cloudLight);
    table.set(hexToUnitRgb(p.cloudShadow), o + P.cloudShadow);
    table.set(hexToUnitRgb(p.glow), o + P.glow);
    table[o + P.sunX] = p.sunX;
    table[o + P.sunY] = p.sunY;
    table[o + P.glowRadius] = p.glowRadius;
    table[o + P.glowStrength] = p.glowStrength;
    table[o + P.discRadius] = p.discRadius;
    table[o + P.discStrength] = p.discStrength;
    const len = Math.hypot(p.lightX, p.lightY) || 1;
    table[o + P.lightX] = p.lightX / len;
    table[o + P.lightY] = p.lightY / len;
  });
  return table;
}

// ---------------------------------------------------------------------------
// Smooth preset transition
// ---------------------------------------------------------------------------

/** Seconds a time-of-day change takes to blend in. */
export const TRANSITION_SECONDS = 2;

/** Eased progress (smoothstep) of a transition `elapsed` seconds into `duration`. */
export function transitionWeight(elapsed: number, duration: number): number {
  if (!(duration > 0)) return 1;
  const x = elapsed / duration;
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

/**
 * Writes `a + (b - a) * t` for one preset row into `out[0..PRESET_STRIDE)`, with
 * `a` and `b` read at `aOff` and `bOff`. Allocates nothing; `out` may alias `a`.
 */
export function lerpPreset(
  out: Float32Array,
  a: Float32Array,
  aOff: number,
  b: Float32Array,
  bOff: number,
  t: number,
): Float32Array {
  for (let i = 0; i < PRESET_STRIDE; i++) {
    const x = a[aOff + i];
    out[i] = x + (b[bOff + i] - x) * t;
  }
  return out;
}

export interface PresetTransition {
  /** Current blended preset row (`PRESET_STRIDE` floats). Reused every update. */
  readonly values: Float32Array;
  /**
   * Advances by `dt` seconds towards row `index` of the table. A new index starts
   * a fresh blend from the current values (so an interrupted blend never jumps).
   * The very first call snaps straight to the target. Returns true if `values`
   * changed. Allocates nothing.
   */
  update(dt: number, index: number): boolean;
}

export function createPresetTransition(
  table: Float32Array,
  duration = TRANSITION_SECONDS,
): PresetTransition {
  const values = new Float32Array(PRESET_STRIDE);
  const from = new Float32Array(PRESET_STRIDE);
  let target = -1;
  let elapsed = 0;
  let active = false;
  return {
    values,
    update(dt, index) {
      if (target < 0) {
        target = index;
        lerpPreset(values, table, index * PRESET_STRIDE, table, index * PRESET_STRIDE, 0);
        return true;
      }
      if (index !== target) {
        target = index;
        from.set(values);
        elapsed = 0;
        active = true;
      }
      if (!active) return false;
      elapsed += dt > 0 ? dt : 0;
      lerpPreset(
        values,
        from,
        0,
        table,
        index * PRESET_STRIDE,
        transitionWeight(elapsed, duration),
      );
      if (elapsed >= duration) active = false;
      return true;
    },
  };
}
