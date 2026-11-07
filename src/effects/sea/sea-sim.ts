/**
 * Pure JS logic for the calm sea (sea.ts): the swell sum and its analytic
 * gradient (the JS twin of the shader's), Schlick Fresnel, the ripple slope
 * texture, the `time` presets and the headland profile. Nothing here touches GL.
 */
import { hexToUnitRgb, type Rgb } from "../color";
import { sampleSky, type SkyKey, type SkyState } from "../horizon/horizon-sim";
import { clamp, smoothstep, wrap } from "../math";
import { createNoise, createRng, fbmPeriodic2 } from "../noise";
import { lookup } from "../lookup";

const TAU = Math.PI * 2;
const GRAVITY = 9.81;

// ---------------------------------------------------------------------------
// Swell
// ---------------------------------------------------------------------------

/** One long swell: wavelength (m), heading (radians off straight towards the viewer) and steepness (a·k). */
export interface SwellSpec {
  length: number;
  heading: number;
  steepness: number;
}

/** The swells, longest first. Steepness is at `swell` = 1: a calm sea. */
export const SWELLS: readonly SwellSpec[] = [
  { length: 70, heading: 0.12, steepness: 0.045 },
  { length: 41, heading: -0.35, steepness: 0.03 },
  { length: 23, heading: 0.6, steepness: 0.02 },
];

/** A swell resolved into its wave vector, angular frequency and height amplitude at `swell` = 1. */
export interface SwellWave {
  /** Wave vector (rad/m) on the plane: x right, z away from the viewer. */
  kx: number;
  kz: number;
  k: number;
  /** Deep-water dispersion: ω = sqrt(g k), rad/s. */
  omega: number;
  /** Height amplitude (m). */
  amp: number;
}

export function resolveSwells(specs: readonly SwellSpec[] = SWELLS): SwellWave[] {
  return specs.map(({ length, heading, steepness }) => {
    const k = TAU / length;
    // Rolling towards the viewer: the crests travel along -z.
    return {
      kx: k * Math.sin(heading),
      kz: -k * Math.cos(heading),
      k,
      omega: Math.sqrt(GRAVITY * k),
      amp: steepness / k,
    };
  });
}

/**
 * Advances each wave's phase by -ω dt (the argument is k·P + phase, so the crests
 * move along k), wrapped to [0, 2π). Allocates nothing.
 */
export function advanceSwellPhases(
  phases: Float64Array,
  waves: readonly SwellWave[],
  dt: number,
): void {
  for (let i = 0; i < waves.length; i++) {
    phases[i] = wrap(phases[i] - waves[i].omega * dt, 0, TAU);
  }
}

/** Height (m) of the swell sum at (x, z), with amplitudes scaled by `scale`. */
export function swellHeight(
  waves: readonly SwellWave[],
  phases: Float64Array,
  scale: number,
  x: number,
  z: number,
): number {
  let h = 0;
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    h += scale * w.amp * Math.sin(w.kx * x + w.kz * z + phases[i]);
  }
  return h;
}

/** Analytic gradient (dh/dx, dh/dz) of `swellHeight`, written into `out`. */
export function swellGradient(
  waves: readonly SwellWave[],
  phases: Float64Array,
  scale: number,
  x: number,
  z: number,
  out: [number, number],
): [number, number] {
  let gx = 0;
  let gz = 0;
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    const c = scale * w.amp * Math.cos(w.kx * x + w.kz * z + phases[i]);
    gx += w.kx * c;
    gz += w.kz * c;
  }
  out[0] = gx;
  out[1] = gz;
  return out;
}

/** Upper bound of |swellHeight| at `scale`. */
export function swellBound(waves: readonly SwellWave[], scale: number): number {
  let b = 0;
  for (const w of waves) {
    b += Math.abs(scale * w.amp);
  }
  return b;
}

// ---------------------------------------------------------------------------
// Fresnel
// ---------------------------------------------------------------------------

/** Reflectance of water at normal incidence. */
export const WATER_F0 = 0.02;

/** Schlick's Fresnel approximation for `cosTheta` (clamped to [0, 1]); the shader's twin. */
export function schlick(cosTheta: number, f0 = WATER_F0): number {
  const m = 1 - clamp(cosTheta, 0, 1);
  const m2 = m * m;
  return f0 + (1 - f0) * m2 * m2 * m;
}

// ---------------------------------------------------------------------------
// Ripple slopes
// ---------------------------------------------------------------------------

/** Noise lattice cells across the ripple texture. */
export const RIPPLE_CELLS = 8;

export interface RippleSlopes {
  /** RG8 texels: 0.5 + 0.5 · slope / max|slope|, per axis. */
  data: Uint8Array;
  /** Root-mean-square of the decoded (−1..1) slope, per component. */
  rms: number;
}

/**
 * A seamlessly tiling RG8 texture of the slopes of a two-octave periodic fBm
 * height field, by central differences in float (an 8-bit height map would
 * quantise them badly). Normalised so the steepest slope uses the full range.
 */
export function buildRippleSlopes(size: number, seed: number): RippleSlopes {
  const noise = createNoise(seed);
  const k = RIPPLE_CELLS / size;
  const e = 0.25 * k;
  const gx = new Float32Array(size * size);
  const gy = new Float32Array(size * size);
  let max = 1e-9;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * k;
      const v = y * k;
      const dx =
        fbmPeriodic2(noise, u + e, v, RIPPLE_CELLS, 2) -
        fbmPeriodic2(noise, u - e, v, RIPPLE_CELLS, 2);
      const dy =
        fbmPeriodic2(noise, u, v + e, RIPPLE_CELLS, 2) -
        fbmPeriodic2(noise, u, v - e, RIPPLE_CELLS, 2);
      const i = y * size + x;
      gx[i] = dx;
      gy[i] = dy;
      max = Math.max(max, Math.abs(dx), Math.abs(dy));
    }
  }
  const data = new Uint8Array(size * size * 2);
  let sum = 0;
  for (let i = 0; i < size * size; i++) {
    const a = Math.round((0.5 + (0.5 * gx[i]) / max) * 255);
    const b = Math.round((0.5 + (0.5 * gy[i]) / max) * 255);
    data[i * 2] = a;
    data[i * 2 + 1] = b;
    const da = (a / 255) * 2 - 1;
    const db = (b / 255) * 2 - 1;
    sum += da * da + db * db;
  }
  return { data, rms: Math.sqrt(sum / (2 * size * size)) };
}

// ---------------------------------------------------------------------------
// Time presets
// ---------------------------------------------------------------------------

export type SeaTime = "sunset" | "dusk" | "moonlight" | "overcast";

export interface SeaPreset {
  /** Hour to sample `SKY_KEYS` at, or a sky key table of its own (sampled at noon). */
  sky: number | readonly SkyKey[];
  /** Glow strength override (the moon's halo), or undefined to keep the key's. */
  glowStrength?: number;
  /** Glow colour override. */
  glow?: Rgb;
  /** Height of the sun or moon centre above the horizon, as a fraction of the frame height. */
  lightY: number;
  /** Disc radius as a fraction of the frame height; 0 for none. */
  disc: number;
  discColor: Rgb;
  /** Colour and strength of the glitter path's light. */
  lightColor: Rgb;
  intensity: number;
  /** Base Beckmann m² of the glitter lobe; larger is broader and softer. */
  roughness: number;
  /** Colour of the water seen straight down (no reflection). */
  deep: Rgb;
}

const OVERCAST_KEY: SkyKey = {
  hour: 12,
  zenith: hexToUnitRgb("#5c6672"),
  horizon: hexToUnitRgb("#a2a9ae"),
  glow: hexToUnitRgb("#d4d0c6"),
  light: hexToUnitRgb("#9aa0a4"),
  glowStrength: 0.35,
};

export const SEA_PRESETS: Readonly<Record<SeaTime, SeaPreset>> = {
  sunset: {
    sky: 18.15,
    lightY: 0.07,
    disc: 0.032,
    discColor: hexToUnitRgb("#ffd59a"),
    lightColor: hexToUnitRgb("#ffb66a"),
    intensity: 1,
    roughness: 0.012,
    deep: hexToUnitRgb("#16233a"),
  },
  dusk: {
    sky: 18.8,
    lightY: -0.025,
    disc: 0,
    discColor: hexToUnitRgb("#ff9a5a"),
    lightColor: hexToUnitRgb("#e07a6a"),
    intensity: 0.3,
    roughness: 0.03,
    deep: hexToUnitRgb("#0e1430"),
  },
  moonlight: {
    sky: 1,
    glowStrength: 0.3,
    glow: hexToUnitRgb("#3a4a7a"),
    lightY: 0.2,
    disc: 0.024,
    discColor: hexToUnitRgb("#f2efe2"),
    lightColor: hexToUnitRgb("#c8d4f0"),
    intensity: 0.45,
    roughness: 0.012,
    deep: hexToUnitRgb("#03071a"),
  },
  overcast: {
    sky: [OVERCAST_KEY],
    lightY: 0.16,
    disc: 0,
    discColor: hexToUnitRgb("#ffffff"),
    lightColor: hexToUnitRgb("#e6e2d8"),
    intensity: 0.12,
    roughness: 0.06,
    deep: hexToUnitRgb("#28353d"),
  },
};

/** The preset for a `time` select value, falling back to sunset. */
export const seaPreset = (time: string): SeaPreset => lookup(SEA_PRESETS, time, "sunset");

/** Fills `out` with the sky for `preset`. */
export function presetSky(preset: SeaPreset, out: SkyState): SkyState {
  if (typeof preset.sky === "number") {
    sampleSky(preset.sky / 24, out);
  } else {
    sampleSky(0.5, out, preset.sky);
  }
  if (preset.glowStrength !== undefined) {
    out.glowStrength = preset.glowStrength;
  }
  if (preset.glow) {
    out.glow[0] = preset.glow[0];
    out.glow[1] = preset.glow[1];
    out.glow[2] = preset.glow[2];
  }
  return out;
}

/** The distant headland's silhouette colour: the horizon sky, darkened and slightly hazed. */
export function landColor(sky: SkyState, out: Rgb): Rgb {
  for (let c = 0; c < 3; c++) {
    out[c] = sky.horizon[c] * 0.38 + sky.zenith[c] * 0.12;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Headland
// ---------------------------------------------------------------------------

export const LAND_COLUMNS = 256;
/** Highest point of the headland, as a fraction of the frame height. */
export const LAND_HEIGHT = 0.038;
/** Where the headland's tip meets the sea, as a fraction of the width from its side. */
export const LAND_TIP = 0.34;

/**
 * Fills `out` (`LAND_COLUMNS` floats) with a low headland rising from the left
 * edge and tapering into the sea at `LAND_TIP`: heights as fractions of the frame
 * height above the horizon at x = column / (LAND_COLUMNS - 1). The shader mirrors
 * it to put it opposite the sun. Deterministic for a seed.
 */
export function buildHeadland(out: Float32Array, seed: number): Float32Array {
  const rand = createRng(seed);
  const f = [2 + rand(), 5 + rand() * 2, 11 + rand() * 4];
  const ph = [rand() * TAU, rand() * TAU, rand() * TAU];
  for (let c = 0; c < LAND_COLUMNS; c++) {
    const x = c / (LAND_COLUMNS - 1);
    const body = 1 - smoothstep(0.02, LAND_TIP, x);
    const bumps =
      1 +
      0.18 * Math.sin(TAU * f[0] * x + ph[0]) +
      0.08 * Math.sin(TAU * f[1] * x + ph[1]) +
      0.03 * Math.sin(TAU * f[2] * x + ph[2]);
    out[c] = LAND_HEIGHT * Math.sqrt(body) * (bumps / 1.29);
  }
  return out;
}
