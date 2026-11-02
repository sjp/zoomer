/**
 * Pure (GL-free) logic for the fireplace effect: palettes and the heat-to-colour ramp,
 * the tiling noise texture, the hearth silhouette profile, the fire layout and the
 * ember simulation. Everything here is unit tested.
 */
import { createNoise } from "./noise";

/** One palette stop: heat position 0..1, straight (not premultiplied) colour and alpha. */
export interface RampStop {
  at: number;
  rgb: readonly [number, number, number];
  a: number;
}

export interface FirePalette {
  /** Heat ramp, sorted by `at`, first at 0 and last at 1. */
  ramp: readonly RampStop[];
  /** Ambient glow and log rim-light colour, 0..1. */
  glow: readonly [number, number, number];
  /** Ember colour, 0..1. */
  ember: readonly [number, number, number];
}

const stop = (at: number, r: number, g: number, b: number, a: number): RampStop => ({
  at,
  rgb: [r, g, b],
  a,
});

export const PALETTES = {
  wood: {
    ramp: [
      stop(0, 0.45, 0.02, 0.0, 0),
      stop(0.14, 0.55, 0.05, 0.01, 0.45),
      stop(0.38, 1.0, 0.32, 0.04, 0.88),
      stop(0.68, 1.0, 0.72, 0.22, 1),
      stop(1, 1.0, 0.97, 0.86, 1),
    ],
    glow: [1.0, 0.42, 0.12],
    ember: [1.0, 0.55, 0.16],
  },
  gas: {
    ramp: [
      stop(0, 0.04, 0.08, 0.5, 0),
      stop(0.16, 0.08, 0.18, 0.85, 0.45),
      stop(0.45, 0.28, 0.55, 1.0, 0.85),
      stop(0.75, 0.68, 0.85, 1.0, 1),
      stop(1, 0.94, 0.97, 1.0, 1),
    ],
    glow: [0.25, 0.45, 1.0],
    ember: [0.6, 0.8, 1.0],
  },
  magic: {
    ramp: [
      stop(0, 0.35, 0.04, 0.55, 0),
      stop(0.16, 0.55, 0.1, 0.85, 0.5),
      stop(0.45, 0.2, 0.9, 0.42, 0.88),
      stop(0.75, 0.62, 1.0, 0.62, 1),
      stop(1, 0.92, 1.0, 0.9, 1),
    ],
    glow: [0.42, 0.45, 0.9],
    ember: [0.7, 1.0, 0.6],
  },
} as const satisfies Record<string, FirePalette>;

export type PaletteId = keyof typeof PALETTES;

export const PALETTE_OPTIONS = [
  { value: "wood", label: "Wood fire" },
  { value: "gas", label: "Gas (blue)" },
  { value: "magic", label: "Magic (green/purple)" },
] as const;

/** Looks up a palette by select value; unknown values fall back to wood. */
export function getPalette(id: string): FirePalette {
  return id === "gas" || id === "magic" ? PALETTES[id] : PALETTES.wood;
}

/** Texels in the heat ramp texture. */
export const RAMP_SIZE = 256;

/**
 * Fills `out` (RGBA8, `size` texels) with the palette's heat ramp, linearly
 * interpolated between stops, with colour premultiplied by alpha so the low-res
 * flame texture can be bilinearly upscaled and composited as `bg * (1 - a) + rgb`.
 */
export function buildRamp(
  stops: readonly RampStop[],
  size = RAMP_SIZE,
  out = new Uint8Array(size * 4),
): Uint8Array {
  let k = 0;
  for (let i = 0; i < size; i++) {
    const h = size > 1 ? i / (size - 1) : 0;
    while (k < stops.length - 2 && h > stops[k + 1].at) k++;
    const s0 = stops[k];
    const s1 = stops[Math.min(k + 1, stops.length - 1)];
    const span = s1.at - s0.at;
    const t = span > 0 ? Math.min(1, Math.max(0, (h - s0.at) / span)) : 0;
    const a = s0.a + (s1.a - s0.a) * t;
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const v = s0.rgb[c] + (s1.rgb[c] - s0.rgb[c]) * t;
      out[o + c] = Math.round(Math.min(1, Math.max(0, v * a)) * 255);
    }
    out[o + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
  }
  return out;
}

/** Noise texture side in texels, and lattice cells across it. */
export const NOISE_SIZE = 128;
export const NOISE_PERIOD = 16;

/**
 * A seamlessly tiling RG8 noise texture (`size` x `size`, 2 bytes per texel):
 * two independent single-octave gradient noises, each mapped from about [-1, 1] to
 * 0..255. The shader sums scaled lookups of R into fBm and uses G as a domain warp.
 */
export function buildNoiseTexture(size = NOISE_SIZE, period = NOISE_PERIOD, seed = 0xf12e) {
  const a = createNoise(seed);
  const b = createNoise(seed + 1);
  const out = new Uint8Array(size * size * 2);
  const k = period / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 2;
      const r = a.periodic2(x * k, y * k, period, period);
      const g = b.periodic2(x * k, y * k, period, period);
      out[o] = Math.round(Math.min(1, Math.max(0, r * 0.5 + 0.5)) * 255);
      out[o + 1] = Math.round(Math.min(1, Math.max(0, g * 0.5 + 0.5)) * 255);
    }
  }
  return out;
}

/** Fire placement in reference units (1080 tall), x from the left, y up from the bottom. */
export interface FireLayout {
  /** Fire centre x. */
  cx: number;
  /** Half-width of the flame base. */
  halfW: number;
  /** Flame base line (v = 0). */
  baseY: number;
  /** Nominal flame height (v = 1). */
  flameH: number;
  /** Hearth floor top. */
  floorH: number;
}

/** Height of the hearth floor, in reference px. */
export const FLOOR_H = 34;

/** Bounds of the shaded flame region in normalised flame space (u across, v up). */
export const FIRE_U = 1.2;
export const FIRE_V_MIN = -0.1;
export const FIRE_V_MAX = 1.3;

/** Lays the fire out for a frame `refWidth` reference px wide; `height` is 0..1 of the frame. */
export function fireLayout(refWidth: number, height: number): FireLayout {
  const halfW = Math.max(60, Math.min(refWidth * 0.36, 680));
  return {
    cx: refWidth / 2,
    halfW,
    baseY: FLOOR_H + halfW * 0.07,
    flameH: Math.max(40, height * 1080),
    floorH: FLOOR_H,
  };
}

/**
 * Logs as [centre x, half-length, bottom above floor at the left end, at the right
 * end, radius], all in halfW units. Leaning logs cross to read as a pile.
 */
const LOGS: readonly (readonly [number, number, number, number, number])[] = [
  [-0.46, 0.5, 0, 0, 0.07],
  [0.44, 0.54, 0, 0, 0.075],
  [-0.14, 0.56, 0, 0.17, 0.06],
  [0.2, 0.5, 0.15, 0.01, 0.056],
];

/**
 * Fills `out` with the top of the hearth silhouette (floor plus side-on logs with
 * rounded ends), in reference px above the frame bottom, sampled at the centres of
 * `out.length` columns spanning `refWidth`.
 */
export function buildHearthProfile(out: Float32Array, refWidth: number, layout: FireLayout) {
  const n = out.length;
  const { cx, halfW, floorH } = layout;
  for (let i = 0; i < n; i++) {
    const x = ((i + 0.5) / n) * refWidth;
    let top = floorH;
    for (const [lx, len, bottomL, bottomR, rad] of LOGS) {
      const d = x - (cx + lx * halfW);
      const dx = Math.abs(d);
      const l = len * halfW;
      const r = rad * halfW;
      if (dx >= l) continue;
      const t = 0.5 + (0.5 * d) / l;
      const y0 = floorH + (bottomL + (bottomR - bottomL) * t) * halfW;
      // Body 2r tall; within r of either end, a circular cap.
      const e = dx - (l - r);
      const h = e <= 0 ? 2 * r : r + Math.sqrt(Math.max(0, r * r - e * e));
      top = Math.max(top, y0 + h);
    }
    out[i] = top;
  }
  return out;
}

/** Largest silhouette height for a layout, in reference px (for the shader's early-out). */
export function hearthMaxHeight(layout: FireLayout): number {
  let top = layout.floorH;
  for (const [, , bottomL, bottomR, rad] of LOGS) {
    top = Math.max(top, layout.floorH + (Math.max(bottomL, bottomR) + 2 * rad) * layout.halfW);
  }
  return top;
}

/** Ember particles in reference px, x from the left, y up from the bottom. */
export interface EmberState {
  readonly max: number;
  count: number;
  /** Fractional embers owed by the spawn rate. */
  spawnDebt: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly size: Float32Array;
  readonly seed: Float32Array;
}

export function createEmberState(max: number): EmberState {
  const f = () => new Float32Array(max);
  return {
    max,
    count: 0,
    spawnDebt: 0,
    x: f(),
    y: f(),
    vx: f(),
    vy: f(),
    age: f(),
    life: f(),
    size: f(),
    seed: f(),
  };
}

export interface EmberEnv {
  /** Embers spawned per (simulated) second. */
  rate: number;
  layout: FireLayout;
  /** Terminal rise speed in reference px/s. */
  rise: number;
  /** Simulation time in seconds, for the curl field. */
  time: number;
  /** Top of the frame in reference px; embers above it are removed. */
  top: number;
}

/** Sideways acceleration scale for the curl field, in reference px/s². */
const CURL_ACCEL = 260;

/**
 * Advances embers by `dt` simulated seconds: spawns at `env.rate` over the lower
 * flames, then each ember rises towards `env.rise`, is pushed sideways by `curl`
 * (roughly [-1, 1], e.g. a slow noise field) with drag, and is removed once its life
 * runs out or it leaves the top. Dead embers are swap-removed, so live ones stay in
 * `0 .. count - 1`. Allocates nothing.
 */
export function stepEmbers(
  s: EmberState,
  dt: number,
  env: EmberEnv,
  rng: () => number,
  curl: (x: number, y: number, t: number) => number,
) {
  if (dt <= 0) return;
  const { layout } = env;
  s.spawnDebt = Math.min(s.spawnDebt + Math.max(0, env.rate) * dt, s.max);
  while (s.spawnDebt >= 1) {
    s.spawnDebt -= 1;
    if (s.count >= s.max) continue;
    const i = s.count++;
    s.x[i] = layout.cx + (rng() + rng() - 1) * layout.halfW * 0.55;
    s.y[i] = layout.baseY + rng() * layout.flameH * 0.35;
    s.vx[i] = (rng() - 0.5) * 40;
    s.vy[i] = env.rise * (0.4 + rng() * 0.5);
    s.age[i] = 0;
    s.life[i] = 1.8 + rng() * 2.4;
    s.size[i] = 0.7 + rng() * 0.8;
    s.seed[i] = rng() * Math.PI * 2;
  }
  const lift = Math.min(1, dt * 0.8);
  const drag = Math.min(1, dt * 1.2);
  let i = 0;
  while (i < s.count) {
    const age = s.age[i] + dt;
    let y = s.y[i];
    if (age >= s.life[i] || y > env.top) {
      const last = --s.count;
      s.x[i] = s.x[last];
      s.y[i] = s.y[last];
      s.vx[i] = s.vx[last];
      s.vy[i] = s.vy[last];
      s.age[i] = s.age[last];
      s.life[i] = s.life[last];
      s.size[i] = s.size[last];
      s.seed[i] = s.seed[last];
      continue;
    }
    let vx = s.vx[i];
    let vy = s.vy[i];
    vy += (env.rise - vy) * lift;
    vx += curl(s.x[i], y, env.time) * CURL_ACCEL * dt;
    vx -= vx * drag;
    s.x[i] += vx * dt;
    y += vy * dt;
    s.y[i] = y;
    s.vx[i] = vx;
    s.vy[i] = vy;
    s.age[i] = age;
    i++;
  }
}

/** Ember opacity 0..1: a quick fade-in, a slow fade-out and a gentle twinkle. */
export function emberAlpha(age: number, life: number, seed: number, time: number): number {
  if (life <= 0 || age >= life) return 0;
  const fadeIn = Math.min(1, age / 0.3);
  const out = 1 - age / life;
  return fadeIn * out * out * (0.72 + 0.28 * Math.sin(time * 9 + seed));
}
