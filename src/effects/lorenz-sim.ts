/**
 * Pure model for the Lorenz Attractor effect: the three chaotic systems, an RK4
 * step, the long pre-computed trajectory that particles seed and respawn on, its
 * framing, the orbiting camera and the palettes. The effect's GLSL mirrors
 * `deriv`, `rk4Step` and `project`.
 */
import { clamp, wrap } from "./math";
import { createRng } from "./noise";
import type { PALETTE_OPTIONS, POSITION_OPTIONS, SYSTEM_OPTIONS } from "./lorenz.meta";

export type SystemId = (typeof SYSTEM_OPTIONS)[number]["value"];
export type PaletteId = (typeof PALETTE_OPTIONS)[number]["value"];
export type PositionId = (typeof POSITION_OPTIONS)[number]["value"];
export type Vec3 = readonly [number, number, number];

const TAU = Math.PI * 2;

/** Lorenz (1963): sigma, rho, beta. */
export const LORENZ = { sigma: 10, rho: 28, beta: 8 / 3 } as const;
/** Aizawa: the usual published constants. */
export const AIZAWA = { a: 0.95, b: 0.7, c: 0.6, d: 3.5, e: 0.25, f: 0.1 } as const;
/** Thomas: cyclically symmetric, chaotic for b below about 0.208186. */
export const THOMAS = { b: 0.208186 } as const;

export interface AttractorSystem {
  /** `uSystem` in the shaders. */
  readonly index: number;
  /** Where the stored trajectory starts, before the burn-in. */
  readonly start: Vec3;
  /** RK4 step (system time) for the stored trajectory. */
  readonly step: number;
  /** Steps between stored samples. */
  readonly stride: number;
  /** Steps run and discarded first, so the trajectory starts on the attractor. */
  readonly burnIn: number;
  /** System time per real second at flow speed 1: about four seconds per loop. */
  readonly rate: number;
  /**
   * Wing axis in framed (normalised) coordinates, scaled so the dot product with a
   * point runs about -1 to 1 from one wing (or lobe) to the other.
   */
  readonly wing: Vec3;
}

export const SYSTEMS: Readonly<Record<SystemId, AttractorSystem>> = {
  lorenz: {
    index: 0,
    start: [0.1, 0, 0],
    step: 0.004,
    stride: 4,
    burnIn: 2000,
    rate: 0.16,
    wing: [2.4, 2.4, 0],
  },
  aizawa: {
    index: 1,
    start: [0.1, 0, 0],
    step: 0.01,
    stride: 4,
    burnIn: 4000,
    rate: 0.32,
    wing: [0, 0, 1.4],
  },
  thomas: {
    index: 2,
    start: [0.1, 0, -0.1],
    step: 0.04,
    stride: 4,
    burnIn: 4000,
    rate: 2.5,
    wing: [2, -2, 0],
  },
};

export function systemFor(id: string): AttractorSystem {
  return id in SYSTEMS ? SYSTEMS[id as SystemId] : SYSTEMS.lorenz;
}

/** The system's velocity at (x, y, z), written to `out[o..o+2]`. */
export function deriv(
  sys: AttractorSystem,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
  o = 0,
): void {
  if (sys.index === 0) {
    out[o] = LORENZ.sigma * (y - x);
    out[o + 1] = x * (LORENZ.rho - z) - y;
    out[o + 2] = x * y - LORENZ.beta * z;
  } else if (sys.index === 1) {
    const zb = z - AIZAWA.b;
    out[o] = zb * x - AIZAWA.d * y;
    out[o + 1] = AIZAWA.d * x + zb * y;
    out[o + 2] =
      AIZAWA.c +
      AIZAWA.a * z -
      (z * z * z) / 3 -
      (x * x + y * y) * (1 + AIZAWA.e * z) +
      AIZAWA.f * z * x * x * x;
  } else {
    out[o] = Math.sin(y) - THOMAS.b * x;
    out[o + 1] = Math.sin(z) - THOMAS.b * y;
    out[o + 2] = Math.sin(x) - THOMAS.b * z;
  }
}

/** Scratch for `rk4Step`: four stages of three. */
export function rk4Scratch(): Float64Array {
  return new Float64Array(12);
}

/** One classic RK4 step of `h` from `p` (x, y, z), in place. `k` comes from `rk4Scratch`. */
export function rk4Step(sys: AttractorSystem, p: Float64Array, h: number, k: Float64Array): void {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  const hh = h / 2;
  deriv(sys, x, y, z, k, 0);
  deriv(sys, x + hh * k[0], y + hh * k[1], z + hh * k[2], k, 3);
  deriv(sys, x + hh * k[3], y + hh * k[4], z + hh * k[5], k, 6);
  deriv(sys, x + h * k[6], y + h * k[7], z + h * k[8], k, 9);
  const s = h / 6;
  p[0] = x + s * (k[0] + 2 * k[3] + 2 * k[6] + k[9]);
  p[1] = y + s * (k[1] + 2 * k[4] + 2 * k[7] + k[10]);
  p[2] = z + s * (k[2] + 2 * k[5] + 2 * k[8] + k[11]);
}

/** The stored trajectory is a TRAJ_W x TRAJ_H RGBA32F texture, one sample per texel. */
export const TRAJ_W = 128;
export const TRAJ_H = 64;
export const TRAJ_SAMPLES = TRAJ_W * TRAJ_H;

export interface Trajectory {
  /** TRAJ_SAMPLES samples of (x, y, z, 1) in system coordinates. */
  readonly points: Float32Array;
  /** Middle of the bounding box, system coordinates. */
  readonly centre: Vec3;
  /**
   * System units to framed units: the trajectory fits a vertical cylinder of
   * radius 1 and half-height 1 around `centre`.
   */
  readonly norm: number;
  /** 10th and 90th percentile speeds (system units per system second), for colour. */
  readonly speedLo: number;
  readonly speedHi: number;
}

/** One long trajectory on the attractor, with its framing and speed range. */
export function buildTrajectory(sys: AttractorSystem): Trajectory {
  const p = Float64Array.from(sys.start);
  const k = rk4Scratch();
  for (let i = 0; i < sys.burnIn; i++) rk4Step(sys, p, sys.step, k);
  const points = new Float32Array(TRAJ_SAMPLES * 4);
  const speeds = new Float64Array(TRAJ_SAMPLES);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < TRAJ_SAMPLES; i++) {
    for (let s = 0; s < sys.stride; s++) rk4Step(sys, p, sys.step, k);
    for (let a = 0; a < 3; a++) {
      points[i * 4 + a] = p[a];
      lo[a] = Math.min(lo[a], p[a]);
      hi[a] = Math.max(hi[a], p[a]);
    }
    points[i * 4 + 3] = 1;
    deriv(sys, p[0], p[1], p[2], k, 0);
    speeds[i] = Math.hypot(k[0], k[1], k[2]);
  }
  const centre: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  let radius = (hi[2] - lo[2]) / 2;
  for (let i = 0; i < TRAJ_SAMPLES; i++) {
    radius = Math.max(radius, Math.hypot(points[i * 4] - centre[0], points[i * 4 + 1] - centre[1]));
  }
  speeds.sort();
  return {
    points,
    centre,
    norm: 1 / radius,
    speedLo: speeds[Math.floor(TRAJ_SAMPLES * 0.1)],
    speedHi: speeds[Math.floor(TRAJ_SAMPLES * 0.9)],
  };
}

/** Floats per particle: x, y, z (system coordinates) and age in seconds. */
export const PARTICLE_FLOATS = 4;
/** Seconds a respawned particle takes to fade in. */
export const FADE_IN = 0.6;
/** Mean seconds between respawns of one particle, to keep coverage even. */
export const RESPAWN_LIFE = 25;
/** Jitter around each seed sample, framed units. */
export const SEED_JITTER = 0.003;

/**
 * Seeds `count` particles at random samples of the trajectory, jittered a little
 * so neighbours separate, with ages past the fade-in so they show at once.
 */
export function seedParticles(
  traj: Trajectory,
  count: number,
  seed: number,
  out: Float32Array,
): Float32Array {
  const rng = createRng(seed);
  const jitter = SEED_JITTER / traj.norm;
  for (let i = 0; i < count; i++) {
    const s = Math.floor(rng() * TRAJ_SAMPLES) * 4;
    const o = i * PARTICLE_FLOATS;
    out[o] = traj.points[s] + (rng() - 0.5) * jitter;
    out[o + 1] = traj.points[s + 1] + (rng() - 0.5) * jitter;
    out[o + 2] = traj.points[s + 2] + (rng() - 0.5) * jitter;
    out[o + 3] = FADE_IN + rng() * 10;
  }
  return out;
}

/** Longest frame the flow integrates, seconds: a hitch slows it rather than jumping. */
export const MAX_DT = 1 / 20;
/** RK4 substeps per frame on the GPU. */
export const SUBSTEPS = 4;

/** System time to advance this frame, from the clamped frame time. */
export function flowStep(dt: number, speed: number, sys: AttractorSystem): number {
  return clamp(Number.isFinite(dt) ? dt : 0, 0, MAX_DT) * Math.max(0, speed) * sys.rate;
}

/** Chance that one particle respawns this frame. */
export function respawnChance(dt: number): number {
  return 1 - Math.exp(-clamp(Number.isFinite(dt) ? dt : 0, 0, MAX_DT) / RESPAWN_LIFE);
}

/** Camera yaw in radians per second at orbit 1: a turn every 90 seconds. */
export const ORBIT_RATE = TAU / 90;

/** The camera yaw after `dt` seconds at `orbit` (signed), wrapped to [0, 2 pi). */
export function advanceOrbit(angle: number, dt: number, orbit: number): number {
  const step = Number.isFinite(dt) && dt > 0 ? dt * orbit * ORBIT_RATE : 0;
  return wrap(angle + step, 0, TAU);
}

/** Camera elevation above the attractor's equator, radians. */
export const TILT = 0.3;
/** Camera distance from the centre, framed units. */
export const CAM_DIST = 3.5;
/** Frame heights per framed unit at the centre's depth. */
export const SIZE = 0.34;

/**
 * Projects framed point `q` (relative to the centre, z up) for camera yaw (cos,
 * sin), writing to `out`: screen x and y in units of SIZE frame heights (y up),
 * depth towards the viewer (about -1.2 to 1.2) and the perspective factor.
 */
export function project(
  qx: number,
  qy: number,
  qz: number,
  cos: number,
  sin: number,
  out: Float64Array,
): Float64Array {
  const u = qx * cos - qy * sin;
  const d = qx * sin + qy * cos;
  const ct = Math.cos(TILT);
  const st = Math.sin(TILT);
  const y = qz * ct - d * st;
  const dz = d * ct + qz * st;
  const k = CAM_DIST / (CAM_DIST - dz);
  out[0] = u * k;
  out[1] = y * k;
  out[2] = dz;
  out[3] = k;
  return out;
}

/** Fraction of the canvas width from the centre to a side anchor. */
export const SIDE_FRACTION = 0.27;
/** Most half-widths of the projection, in SIZE units (perspective included). */
export const REACH = 1.25;
/** Gap kept from the canvas edge, frame heights. */
export const EDGE_MARGIN = 0.04;

/**
 * Horizontal offset of the attractor's centre from the canvas centre, frame
 * heights: a quarter-ish of the width to one side, pulled in so it stays on screen.
 */
export function anchorX(position: string, aspect: number): number {
  if (position !== "left" && position !== "right") return 0;
  const side = Math.max(
    0,
    Math.min(SIDE_FRACTION * aspect, aspect / 2 - EDGE_MARGIN - SIZE * REACH),
  );
  return position === "left" ? -side : side;
}

export interface Palette {
  /** Cosine palette a + b cos(2 pi (c t + d)). */
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: number;
  readonly d: Vec3;
  /** Colour by speed, else by wing. */
  readonly bySpeed: boolean;
}

export const PALETTES: Readonly<Record<PaletteId, Palette>> = {
  // Amber (t 0) through a pale neutral to cyan (t 1).
  cyanamber: { a: [0.6, 0.7, 0.575], b: [0.4, -0.1, -0.425], c: 0.5, d: [0, 0, 0], bySpeed: false },
  // Deep blue when slow to near white when fast.
  ice: { a: [0.5, 0.65, 0.85], b: [-0.35, -0.3, -0.15], c: 0.5, d: [0, 0, 0], bySpeed: true },
  // Deep red through orange to yellow.
  ember: { a: [0.9, 0.45, 0.16], b: [-0.1, -0.35, -0.14], c: 0.5, d: [0, 0, 0], bySpeed: true },
  rainbow: {
    a: [0.55, 0.55, 0.55],
    b: [0.45, 0.45, 0.45],
    c: 0.8,
    d: [0, 0.33, 0.67],
    bySpeed: true,
  },
};

export function paletteFor(id: string): Palette {
  return id in PALETTES ? PALETTES[id as PaletteId] : PALETTES.cyanamber;
}

/** The palette's colour at t, written to `out`. */
export function paletteColor(p: Palette, t: number, out: Float64Array): Float64Array {
  for (let i = 0; i < 3; i++) out[i] = p.a[i] + p.b[i] * Math.cos(TAU * (p.c * t + p.d[i]));
  return out;
}

/** Trail decay time constant, seconds. */
export const TRAIL_TAU = 0.3;
/**
 * Extra subtraction per frame for an 8-bit trail layer, so faint residue reaches
 * zero instead of stalling where rounding cancels the decay.
 */
export const CLEAN_8BIT = 0.6 / 255;

/** The fraction of the trail layer kept after `dt` seconds. */
export function trailKeep(dt: number): number {
  return Math.exp(-clamp(Number.isFinite(dt) ? dt : 0, 0, 1) / TRAIL_TAU);
}
