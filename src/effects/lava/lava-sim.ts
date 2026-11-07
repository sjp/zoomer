/**
 * Pure logic for the lava field, shared by `lava.ts` and its tests: the camera
 * presets and the screen-to-ground projection, the crust plates' seed offsets
 * (the JS twin of the shader's `voronoiOffset`), the seam glow model, the
 * breathing phase and the sky presets.
 *
 * Screen space: x in frame heights from the frame centre, y in frame heights from
 * the top (y down). Ground space: x across, z away from the camera, both in plate
 * cells (one Voronoi cell per unit). The camera looks level, so the horizon is a
 * screen row; it sits off the frame centre by shifting the principal point.
 */
import { SEARCH_BOUND } from "../voronoi";
import { lookup } from "../lookup";

export interface Camera {
  /** Eye height above the ground, in cells. */
  height: number;
  /** Horizon row, as a fraction of the frame height from the top. */
  horizon: number;
  /** Focal length, in frame heights. */
  focal: number;
  /** Distance over which the far ground fades into the horizon haze (1 - 1/e), in cells. */
  fog: number;
}

export const CAMERAS = {
  low: { height: 1.6, horizon: 0.36, focal: 1.2, fog: 45 },
  high: { height: 4, horizon: 0.3, focal: 1.2, fog: 80 },
} as const satisfies Record<string, Camera>;

export type CameraName = keyof typeof CAMERAS;

/** The camera for a param value, falling back to low. */
export function camera(name: string): Camera {
  return lookup(CAMERAS, name, "low");
}

/** Farthest ground distance the shader evaluates, in cells; rows nearer the horizon clamp to it. */
export const Z_MAX = 600;

/**
 * Smallest distance below the horizon (frame heights) the shader projects; rows
 * closer to the horizon all map to `Z_MAX`.
 */
export const minDrop = (cam: Camera) => (cam.height * cam.focal) / Z_MAX;

/**
 * Ground point under screen point (x, y), written to `out` as [x, z]. Returns
 * false (leaving `out` alone) on or above the horizon, where no ground is seen.
 */
export function groundFromScreen(x: number, y: number, cam: Camera, out: number[]): boolean {
  const drop = y - cam.horizon;
  if (!(drop > 0)) {
    return false;
  }
  const z = (cam.height * cam.focal) / drop;
  out[0] = (x * z) / cam.focal;
  out[1] = z;
  return true;
}

/** Screen point of ground point (gx, z), z > 0, written to `out` as [x, y]. */
export function screenFromGround(gx: number, z: number, cam: Camera, out: number[]): number[] {
  out[0] = (gx * cam.focal) / z;
  out[1] = cam.horizon + (cam.height * cam.focal) / z;
  return out;
}

/**
 * Ground footprint of one device pixel at distance z, in cells, written to `out`
 * as [across, along]: across = z / (f H), along = z^2 / (h f H) for a frame
 * `heightPx` device pixels tall. The shader filters the seams with these.
 */
export function footprint(z: number, cam: Camera, heightPx: number, out: number[]): number[] {
  const across = z / (cam.focal * heightPx);
  out[0] = across;
  out[1] = (across * z) / cam.height;
  return out;
}

/** Largest jitter of a plate's seed from its cell centre, in cells (Euclidean). */
export const JITTER = 0.34;
/** Largest creep of a seed from its jittered position, in cells. */
export const DRIFT_MAX = 0.04;
/** Seconds per loop of a seed's creep path. */
export const DRIFT_PERIOD = 97;
/** Added to ground coordinates so every cell the shader touches has non-negative indices. */
export const GRID_ORIGIN = 1024;

/** Byte `i` (0..3) of `h` mapped to [-1, 1], as the shader does. */
const byteUnit = (h: number, i: number) => ((h >>> (i * 8)) & 255) * (2 / 255) - 1;

/**
 * Drift uniform for time `t` (seconds, any size): the shared point on every seed's
 * closed creep path, pre-scaled by `DRIFT_MAX / sqrt(2)` (a seed's own hash vector
 * is at most sqrt(2) long).
 */
export function driftUniform(t: number, out: number[]): number[] {
  const a = ((t / DRIFT_PERIOD) % 1) * 2 * Math.PI;
  const amp = DRIFT_MAX / Math.SQRT2;
  out[0] = amp * Math.cos(a);
  out[1] = amp * Math.sin(a);
  return out;
}

/**
 * Offset of the seed with hash `h` from its cell centre for drift uniform `d`,
 * written to `out`. Mirrors the shader's `voronoiOffset`: two hash bytes map from
 * the square onto a disc of radius `JITTER`, and the other two rotate and scale
 * the shared creep point, so each plate creeps its own way.
 */
export function seedOffset(h: number, d: readonly number[], out: number[]): number[] {
  const bx = byteUnit(h, 0);
  const by = byteUnit(h, 1);
  const vx = byteUnit(h, 2);
  const vy = byteUnit(h, 3);
  out[0] = JITTER * bx * Math.sqrt(1 - 0.5 * by * by) + vx * d[0] - vy * d[1];
  out[1] = JITTER * by * Math.sqrt(1 - 0.5 * bx * bx) + vy * d[0] + vx * d[1];
  return out;
}

/** True when every seed offset stays inside the exact 3x3 search. */
export const SEARCH_OK = JITTER + DRIFT_MAX <= SEARCH_BOUND;

/** Seam core half width scale, in cells (the hottest channels reach 1.25 times this). */
export const CORE_MAX = 0.05;
/** Halo falloff length as a multiple of the core half width. */
export const HALO = 2.5;
/** Glow intensity of the core and of the halo at the seam. */
export const CORE_GAIN = 1.25;
export const HALO_GAIN = 0.55;
/** Mean seam length per unit area of the plate tiling (2 for unit cells). */
export const SEAM_DENSITY = 2;
/** Breathing depth: the glow swings between 1 - 2 BREATH and 1. */
export const BREATH = 0.14;
/** Breathing cycles per second at `pulse` = 1. */
export const PULSE_RATE = 1 / 14;
/** Phase cycles across the slow noise's range, so the breathing travels along the seams. */
export const PULSE_SPREAD = 2;

/** Core width factors: [floor, slope] in heat, and in the local heat field. */
export const HEAT_WIDTH = [0.35, 0.65] as const;
export const LOCAL_WIDTH = [0.35, 0.9] as const;
/** Glow amplitude factor in the local heat field: [floor, slope]. */
export const LOCAL_GLOW = [0.4, 0.6] as const;

/** Core half width (cells) for `heat` and the local heat field (both 0..1). */
export function coreWidth(heat: number, local: number): number {
  return (
    CORE_MAX * (HEAT_WIDTH[0] + HEAT_WIDTH[1] * heat) * (LOCAL_WIDTH[0] + LOCAL_WIDTH[1] * local)
  );
}

/** Glow amplitude for `heat` and the local heat field (both 0..1), and the breathing (0..1). */
export function glowAmplitude(heat: number, local: number, breath: number): number {
  return heat * (LOCAL_GLOW[0] + LOCAL_GLOW[1] * local) * (1 - 2 * BREATH + 2 * BREATH * breath);
}

/** Breathing factor (0..1) at phase `phase` (cycles) for slow-noise value `n` (0..1). */
export function breathAt(phase: number, n: number): number {
  return 0.5 + 0.5 * Math.sin(2 * Math.PI * (phase + PULSE_SPREAD * n));
}

/** Advances the breathing phase by `dt` seconds at speed `pulse`, wrapped to [0, 1). */
export function advancePulse(phase: number, dt: number, pulse: number): number {
  const rate = Number.isFinite(pulse) ? Math.max(pulse, 0) : 0;
  const p = phase + dt * rate * PULSE_RATE;
  return p - Math.floor(p);
}

/**
 * Glow intensity (0 to CORE_GAIN + HALO_GAIN) at distance `e` from a seam, in
 * cells, for a pixel footprint `fp` across the seam (cells) and the far-field
 * blend `far` (0..1). The twin of the shader's seam shading:
 *
 * - core: a strip of half width w, box-filtered over the pixel footprint;
 * - halo: exp(-e / s), widened to the footprint with its area kept;
 * - far: both replaced by their average over the plates, where cells shrink
 *   toward a pixel and the nearest seam no longer stands for the pixel.
 */
export function seamGlow(
  e: number,
  fp: number,
  far: number,
  heat: number,
  local: number,
  breath: number,
): number {
  const w = coreWidth(heat, local);
  const amp = glowAmplitude(heat, local, breath);
  const f = Math.max(fp, 1e-4);
  const cov = Math.min(Math.max((Math.min(e + 0.5 * f, w) - Math.max(e - 0.5 * f, -w)) / f, 0), 1);
  const s = HALO * w;
  const se = Math.sqrt(s * s + 0.25 * f * f);
  const halo = (s / se) * Math.exp(-e / se);
  const near = CORE_GAIN * cov + HALO_GAIN * halo;
  const mean = Math.min(SEAM_DENSITY * 2 * (CORE_GAIN * w + HALO_GAIN * s), 1);
  return amp * (near + (mean - near) * far);
}

/** Footprint (cells along z) over which the seams fade into their average glow. */
export const FAR_FADE = [0.35, 1] as const;

export interface SkyPreset {
  zenith: string;
  horizon: string;
  /** Underglow colour of the smoke at full heat. */
  underglow: string;
  /** Smoke density, 0..1. */
  smoke: number;
}

export const SKIES = {
  night: { zenith: "#03040b", horizon: "#160a0d", underglow: "#8c2408", smoke: 0.6 },
  dusk: { zenith: "#0b0f26", horizon: "#4a2228", underglow: "#9a3410", smoke: 0.45 },
  smoky: { zenith: "#08070a", horizon: "#24110d", underglow: "#a8360c", smoke: 0.95 },
} as const satisfies Record<string, SkyPreset>;

export type SkyName = keyof typeof SKIES;

/** The sky for a param value, falling back to night. */
export function sky(name: string): SkyPreset {
  return lookup(SKIES, name, "night");
}
