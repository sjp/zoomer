/**
 * Ferrofluid model: the height field of the pool, the magnet's rhythm, the slowly
 * turning spike lattice, and the camera and screen layout of the ray-marched quad.
 * Pure functions, so they can be tested; `ferro.ts` mirrors `heightAt` and
 * `gradientAt` in GLSL.
 *
 * World units: the pool is a disc of radius 1 on the floor plane y = 0, centred on
 * the origin, with y up. The camera sits on +z, looking down at the pool's centre.
 */
import { approach, clamp, fract, smoothstep, wrap } from "../math";

export const TAU = Math.PI * 2;

/** Height of the resting dome at the pool's centre. */
export const DOME_HEIGHT = 0.12;
/** Extra height of the whole crown at the centre under full magnet. */
export const MOUND_HEIGHT = 0.16;
/** Spike height over lattice spacing under full magnet (at the pool's centre). */
export const SPIKE_ASPECT = 1.8;
/**
 * Spikes only appear once the magnet passes a threshold (as in the real Rosensweig
 * instability) and are full grown near full strength; below it the crown is smooth.
 */
export const SPIKE_ONSET = 0.2;
export const SPIKE_FULL = 0.9;
/** Spike cone base radius, in lattice units (0.5: neighbouring cones just touch). */
export const CONE_RADIUS = 0.5;
/** The lattice spacing grows by this fraction as the magnet weakens. */
export const SPREAD = 0.1;
/** Lattice rotation, radians per second: one turn every two minutes. */
export const SPIN_RATE = TAU / 120;
/** The hexagonal lattice repeats every 60 degrees of rotation. */
export const LATTICE_PERIOD = Math.PI / 3;
/** Rows of the rectangular cell pair that makes the hexagonal lattice. */
export const CELL_Y = Math.sqrt(3);
/** Most the magnet strength may change per second, so a rhythm switch eases over. */
export const MAX_AMP_RATE = 1.5;

/** Floor contact shadow: outer radius and depth at the pool's rim. */
export const SHADOW_RADIUS = 1.5;
export const SHADOW_DEPTH = 0.45;

export const CAMERA_PITCH = (22 * Math.PI) / 180;
export const CAMERA_DISTANCE = 6;
/** Pool radius on screen, in frame heights, at size 1. */
export const POOL_RADIUS = 0.28;
/** Gap between the pool and the frame's bottom (and side) edges, in frame heights. */
export const MARGIN = 0.05;
/** Extra pixels around the projected bounds, for the silhouette's anti-aliasing. */
export const BOUNDS_PAD = 2;

export type Rhythm = "breathe" | "pulse" | "hold";
export type PoolPosition = "left" | "centre" | "right";

export const rhythmOf = (v: string): Rhythm => (v === "breathe" || v === "hold" ? v : "pulse");

export const positionOf = (v: string): PoolPosition =>
  v === "left" || v === "centre" ? v : "right";

/**
 * Magnet strength in [0, 1] at cycle phase `phase` (any real; period 1).
 * - breathe: a raised cosine, always moving.
 * - pulse: rise over a quarter cycle, hold a quarter, relax a quarter, rest a quarter.
 * - hold: always on; only the lattice turns.
 */
export function magnet(phase: number, rhythm: Rhythm): number {
  const u = fract(phase);
  switch (rhythm) {
    case "breathe":
      return 0.5 - 0.5 * Math.cos(TAU * u);
    case "hold":
      return 1;
    case "pulse":
      break;
  }
  return smoothstep(0, 0.25, u) - smoothstep(0.5, 0.75, u);
}

/** Wraps a lattice angle into [0, LATTICE_PERIOD): the lattice looks identical. */
export const wrapAngle = (a: number) => wrap(a, 0, LATTICE_PERIOD);

/** Lattice spacing in world units for a spike density and magnet strength. */
export const spacingFor = (density: number, amp: number) =>
  (1 / Math.max(1, density)) * (1 + SPREAD * (1 - clamp(amp, 0, 1)));

/** What the height field depends on, besides position. */
export interface Field {
  /** Magnet strength, 0..1. */
  amp: number;
  /** Lattice spacing, world units. */
  spacing: number;
  /** Lattice rotation, radians. */
  angle: number;
}

/** Height of the crown over the dome at the pool's centre, world units. */
export const crownHeight = (f: Field) => f.amp * MOUND_HEIGHT;

/** Height of the centre spike over the crown, world units. */
export const spikeHeight = (f: Field) =>
  SPIKE_ASPECT * f.spacing * smoothstep(SPIKE_ONSET, SPIKE_FULL, f.amp);

/** Highest point of the field: the centre spike (the origin is a lattice point). */
export const maxHeight = (f: Field) => DOME_HEIGHT + crownHeight(f) + spikeHeight(f);

/**
 * Spike profile over c = 1 - d / CONE_RADIUS: 0 with a flat fillet at the cone's foot,
 * 1 with slope 1 at its sharp tip.
 */
export const spikeProfile = (c: number) => c * c * (2 - c);

/** Steepest slope of {@link spikeProfile}, at c = 2/3. */
export const PROFILE_SLOPE = 4 / 3;

/**
 * Upper bound of the field over the circle of radius sqrt(r2): every term at its
 * peak but the radial ones. Decreasing in r2, so a ray can be clipped below the
 * bound at its closest approach to the pool's axis.
 */
export function boundAt(r2: number, f: Field): number {
  if (r2 >= 1) {
    return 0;
  }
  const e = 1 - r2;
  return DOME_HEIGHT * (1 - r2 * r2) + e * e * (crownHeight(f) + spikeHeight(f));
}

/** Max of (1 - r^2) r over [0, 1], at r = 1 / sqrt 3. */
const ENVELOPE_SLOPE = 8 / (3 * Math.sqrt(3));

/**
 * A Lipschitz bound of the field: |grad h| never exceeds it. The dome's slope is at
 * most 4 H0, the envelope's 4 (1 - r^2) r times the crown and spike height, and
 * each cone's PROFILE_SLOPE K1 / (CONE_RADIUS spacing) times an envelope of at most 1.
 */
export const lipschitz = (f: Field) =>
  4 * DOME_HEIGHT +
  ENVELOPE_SLOPE * (crownHeight(f) + spikeHeight(f)) +
  (PROFILE_SLOPE * spikeHeight(f)) / (CONE_RADIUS * f.spacing);

/** GLSL-style mod: the result has the sign of `y`. */
const mod = (x: number, y: number) => x - y * Math.floor(x / y);

/**
 * Offset from the nearest point of the hexagonal lattice, in lattice units, written
 * into `out`. The lattice (spacing 1, a point at the origin) is the union of two
 * rectangular grids of cell (1, sqrt 3), the second shifted by half a cell.
 */
export function latticeOffset(x: number, z: number, f: Field, out: number[]): void {
  const c = Math.cos(f.angle);
  const s = Math.sin(f.angle);
  const inv = 1 / f.spacing;
  const lx = (c * x - s * z) * inv;
  const ly = (s * x + c * z) * inv;
  const ax = mod(lx + 0.5, 1) - 0.5;
  const ay = mod(ly + 0.5 * CELL_Y, CELL_Y) - 0.5 * CELL_Y;
  const bx = mod(lx, 1) - 0.5;
  const by = mod(ly, CELL_Y) - 0.5 * CELL_Y;
  if (ax * ax + ay * ay < bx * bx + by * by) {
    out[0] = ax;
    out[1] = ay;
  } else {
    out[0] = bx;
    out[1] = by;
  }
}

const scratch = [0, 0];

/**
 * Fluid height at floor point (x, z): a dome H0 (1 - r^4), plus, scaled by the
 * envelope (1 - r^2)^2, a crown growing with the magnet and a spike on every lattice
 * point, of `spikeProfile(c)` (c = 1 - d / CONE_RADIUS, d the distance to the
 * nearest point).
 * Zero outside the pool. Continuous, non-negative.
 */
export function heightAt(x: number, z: number, f: Field): number {
  const r2 = x * x + z * z;
  if (r2 >= 1) {
    return 0;
  }
  const e = 1 - r2;
  latticeOffset(x, z, f, scratch);
  const c = Math.max(0, 1 - Math.hypot(scratch[0], scratch[1]) / CONE_RADIUS);
  return DOME_HEIGHT * (1 - r2 * r2) + e * e * (crownHeight(f) + spikeHeight(f) * spikeProfile(c));
}

/** Gradient (dh/dx, dh/dz) of {@link heightAt}, written into `out`. */
export function gradientAt(x: number, z: number, f: Field, out: number[]): void {
  const r2 = x * x + z * z;
  if (r2 >= 1) {
    out[0] = 0;
    out[1] = 0;
    return;
  }
  const e = 1 - r2;
  latticeOffset(x, z, f, scratch);
  const d = Math.hypot(scratch[0], scratch[1]);
  const c = Math.max(0, 1 - d / CONE_RADIUS);
  const k1 = spikeHeight(f);
  const s = crownHeight(f) + k1 * spikeProfile(c);
  // d(dome)/dx = -4 H0 r^2 x; d(envelope)/dx = -4 (1 - r^2) x.
  const radial = -4 * DOME_HEIGHT * r2 - 4 * e * s;
  let gx = radial * x;
  let gz = radial * z;
  if (c > 0 && d > 1e-9) {
    // d is measured in the rotated, scaled lattice frame: pull its gradient back.
    const ux = scratch[0] / d;
    const uy = scratch[1] / d;
    const cs = Math.cos(f.angle);
    const sn = Math.sin(f.angle);
    // d(profile)/dc = 4c - 3c^2; dc/dd = -1 / CONE_RADIUS.
    const k = (e * e * k1 * c * (4 - 3 * c) * (-1 / CONE_RADIUS)) / f.spacing;
    gx += k * (cs * ux + sn * uy);
    gz += k * (-sn * ux + cs * uy);
  }
  out[0] = gx;
  out[1] = gz;
}

/** The camera's position and basis (right is +x). */
export const CAMERA = {
  pos: [0, CAMERA_DISTANCE * Math.sin(CAMERA_PITCH), CAMERA_DISTANCE * Math.cos(CAMERA_PITCH)],
  up: [0, Math.cos(CAMERA_PITCH), -Math.sin(CAMERA_PITCH)],
  fwd: [0, -Math.sin(CAMERA_PITCH), -Math.cos(CAMERA_PITCH)],
} as const;

/** Where the pool's camera lands on screen. */
export interface Layout {
  /** Focal length, pixels. */
  focal: number;
  /** Screen position of the pool's centre, pixels, GL orientation (origin bottom-left). */
  anchorX: number;
  anchorY: number;
}

/**
 * Projects world point (x, y, z) to pixels relative to the anchor (GL orientation),
 * written into `out`. The point must be in front of the camera.
 */
export function project(x: number, y: number, z: number, focal: number, out: number[]): void {
  const vx = x - CAMERA.pos[0];
  const vy = y - CAMERA.pos[1];
  const vz = z - CAMERA.pos[2];
  const sy = vy * CAMERA.up[1] + vz * CAMERA.up[2];
  const sz = vy * CAMERA.fwd[1] + vz * CAMERA.fwd[2];
  out[0] = (focal * vx) / sz;
  out[1] = (focal * sy) / sz;
}

const proj = [0, 0];
/** Vertices of the octagons used to bound circles. */
const OCTAGON = 8;
const OCT_GROW = 1 / Math.cos(Math.PI / OCTAGON);

/** Half the projected width of the pool's rim, in units of the focal length. */
const RIM_HALF_WIDTH = (() => {
  let m = 0;
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * TAU;
    project(Math.cos(a), 0, Math.sin(a), 1, proj);
    m = Math.max(m, Math.abs(proj[0]));
  }
  return m;
})();

/** Places the pool for a frame size, size param and position, into `out`. */
export function layoutPool(
  width: number,
  height: number,
  size: number,
  position: PoolPosition,
  out: Layout,
): void {
  // Scale the pool so its rim spans 2 * size * POOL_RADIUS frame heights, but never
  // more than 90% of the frame's width.
  const rim = Math.min(size * POOL_RADIUS * height, 0.45 * width);
  const focal = rim / RIM_HALF_WIDTH;
  out.focal = focal;
  const half = rim;
  const edge = MARGIN * height;
  out.anchorX =
    position === "centre" ? width / 2 : position === "left" ? edge + half : width - edge - half;
  // The rim's nearest point sits MARGIN above the frame's bottom edge.
  project(0, 0, 1, focal, proj);
  out.anchorY = edge - proj[1];
}

/** A scissor rectangle in pixels, GL orientation. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Screen rectangle holding everything the pool pass draws: the floor shadow (radius
 * SHADOW_RADIUS) and the fluid (radius 1, up to `top`), padded and clamped to the frame.
 * Projected octagons around the circles bound their projections, since the
 * perspective projection keeps convex shapes in front of the camera convex.
 */
export function poolBounds(layout: Layout, top: number, width: number, height: number, out: Rect) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let ring = 0; ring < 2; ring++) {
    const r = (ring === 0 ? SHADOW_RADIUS : 1) * OCT_GROW;
    const y = ring === 0 ? 0 : top;
    for (let i = 0; i < OCTAGON; i++) {
      const a = (i / OCTAGON) * TAU;
      project(r * Math.cos(a), y, r * Math.sin(a), layout.focal, proj);
      x0 = Math.min(x0, proj[0]);
      x1 = Math.max(x1, proj[0]);
      y0 = Math.min(y0, proj[1]);
      y1 = Math.max(y1, proj[1]);
    }
  }
  const left = clamp(Math.floor(layout.anchorX + x0 - BOUNDS_PAD), 0, width);
  const right = clamp(Math.ceil(layout.anchorX + x1 + BOUNDS_PAD), 0, width);
  const bottom = clamp(Math.floor(layout.anchorY + y0 - BOUNDS_PAD), 0, height);
  const topPx = clamp(Math.ceil(layout.anchorY + y1 + BOUNDS_PAD), 0, height);
  out.x = left;
  out.y = bottom;
  out.w = right - left;
  out.h = topPx - bottom;
}

/** Studio backdrops: wall gradient (top, bottom), soft-box tint times intensity. */
export const BACKDROPS = {
  grey: { top: "#6f737a", bottom: "#c4c7cc", light: [9, 9, 9] },
  dark: { top: "#08090c", bottom: "#1f2228", light: [8.1, 8.6, 9] },
  warm: { top: "#4a3426", bottom: "#b48d6c", light: [9, 8.1, 7] },
} as const;

export type Backdrop = keyof typeof BACKDROPS;

export const backdropOf = (v: string): Backdrop => (v === "dark" || v === "warm" ? v : "grey");

/** The animation clock: magnet cycle phase, lattice angle, eased magnet strength. */
export interface FerroState {
  /** Cycle phase in [0, 1). */
  phase: number;
  /** Lattice angle in [0, LATTICE_PERIOD). */
  angle: number;
  /** Magnet strength actually shown, rate-limited towards `magnet(phase)`. */
  amp: number;
}

/** Starts mid-crown, so the effect opens with spikes on show. */
export const initialState = (rhythm: Rhythm): FerroState => ({
  phase: 0.3,
  angle: 0,
  amp: magnet(0.3, rhythm),
});

/** Advances the clock by `dt` seconds for a cycle of `period` seconds. */
export function stepState(s: FerroState, dt: number, period: number, rhythm: Rhythm): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  s.phase = wrap(s.phase + step / Math.max(1, period), 0, 1);
  s.angle = wrapAngle(s.angle + step * SPIN_RATE);
  const target = magnet(s.phase, rhythm);
  const lim = MAX_AMP_RATE * step;
  s.amp = approach(s.amp, target, lim);
}
