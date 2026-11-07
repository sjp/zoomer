/**
 * Pure JS side of the Newton's Cradle effect (cradle.ts): the swing clock, the
 * ball poses, the orthographic three-quarter view and the cradle's layout in
 * its corner.
 *
 * Collisions are not simulated. Each impact starts a half period in which one
 * end group swings out and back as a pendulum, `angle = a sin(π s / half)`, so
 * the left group swings on even half periods and the right group on odd ones.
 * At every impact both groups are at rest (angle 0) and the arriving group's
 * speed passes to the leaving one, less a small loss; every `TOPUP_SWINGS`
 * swings the amplitude is topped up again, so it never stops.
 *
 * Screen units are "height units": x runs 0..aspect across the canvas and y
 * 0..1 from the bottom up. The cradle lives in "cradle units", a ball radius
 * each: world x along the row, y up from the desk, z towards the viewer, with
 * the base centred on the origin. The view rotates the world by a yaw about y
 * and then tilts it down by a pitch; view x and y are screen axes (cradle
 * units), view z points towards the viewer.
 */
import type { CradleFinish, CradleScene } from "./cradle.meta";
import { BALLS_RANGE, SIZE_RANGE, SWING_RANGE } from "./cradle.meta";
import { clamp } from "../math";

/** Ball radius, the string length (pivot axis to ball centre) and the pivots' half spacing. */
export const BALL_R = 1;
export const STRING_LEN = 4.5;
export const PIVOT_Z = 2.2;
/** Base slab height; the gap from its top to a resting ball. */
export const BASE_H = 0.5;
const BALL_GAP = 0.9;
/** A resting ball's centre and the pivot axis above it (world y). */
export const REST_Y = BASE_H + BALL_GAP + BALL_R;
export const PIVOT_Y = REST_Y + STRING_LEN;
/** Frame posts stand this far beyond the end balls' centres; the base overhangs them. */
const POST_MARGIN = 2.8;
const BASE_OVERHANG = 0.6;
/** Frame rod radius and string half-width (cradle units). */
export const ROD_R = 0.2;
export const STRING_W = 0.035;

/** Physical scale: centimetres per cradle unit, gravity, and a slow-motion factor for calm. */
export const CM_PER_UNIT = 2.5;
export const GRAVITY = 9.81;
export const SLOW = 2.5;

/** Amplitude kept from swing to swing, and the swings between top-ups. */
export const DECAY = 0.98;
export const TOPUP_SWINGS = 10;
/** The middle balls' nudge after an impact: fraction of the amplitude, and of a half period. */
export const WOBBLE = 0.04;
export const WOBBLE_TIME = 0.3;

/** View yaw (towards the outer side) and downward pitch, radians. */
export const YAW = (28 * Math.PI) / 180;
export const PITCH = (15 * Math.PI) / 180;

/** Cradle unit at size 1 (height units): five balls span about a fifth of a 16:9 frame. */
export const CRADLE_UNIT = 0.02;
/** Lowest point of the base on screen, and the gap to the frame edge (height units). */
export const SEAT_Y = 0.06;
const EDGE_MARGIN = 0.05;
/** Widest the cradle may be, as a fraction of the frame width, to keep the speaker clear. */
export const MAX_WIDTH = 0.25;
/** Slack around the pass box for the desk shadow and antialiasing (cradle units). */
const BOX_PAD = 1.5;

/** Ball count, clamped to the param's range. */
export function ballCount(balls: number): number {
  return Number.isFinite(balls)
    ? clamp(Math.round(balls), BALLS_RANGE[0], BALLS_RANGE[1])
    : BALLS_RANGE[0];
}

/** Balls swinging at each end: 1 or 2, and never the whole row. */
export function liftedCount(lifted: number, count: number): number {
  const m = Number.isFinite(lifted) ? Math.round(lifted) : 1;
  return clamp(m, 1, Math.min(2, count - 1));
}

/** Swing amplitude in radians for a `swing` param in degrees. */
export function swingRadians(swing: number): number {
  const s = Number.isFinite(swing) ? swing : SWING_RANGE[0];
  return (clamp(s, SWING_RANGE[0], SWING_RANGE[1]) * Math.PI) / 180;
}

/** Full period (seconds) of a pendulum `len` cradle units long, slowed by `SLOW`. */
export function pendulumPeriod(len = STRING_LEN): number {
  return 2 * Math.PI * Math.sqrt((len * CM_PER_UNIT) / 100 / GRAVITY) * SLOW;
}

/** Seconds from one impact to the next: half a period. */
export const HALF_PERIOD = pendulumPeriod() / 2;

/** Amplitude of swing number `n` (radians): decays each swing, topped up every `TOPUP_SWINGS`. */
export function swingAmplitude(n: number, amp: number): number {
  const k = ((n % TOPUP_SWINGS) + TOPUP_SWINGS) % TOPUP_SWINGS;
  return amp * DECAY ** k;
}

/**
 * The swing at time `t` (seconds, from the first impact) into `out`:
 * [0] the left group's outward angle, [1] the right group's, [2] the idle
 * middle balls' nudge (signed, +x positive), [3] 0 while the left group swings
 * and 1 while the right does. Angles in radians; at most one of [0] and [1] is
 * non-zero.
 */
export function swingState(t: number, amp: number, out: Float64Array, half = HALF_PERIOD): void {
  const n = Math.floor(t / half);
  const s = t - n * half;
  const a = swingAmplitude(n, amp);
  const angle = a * Math.sin((Math.PI * s) / half);
  const left = (n & 1) === 0;
  out[0] = left ? angle : 0;
  out[1] = left ? 0 : angle;
  // The impact pushes the middle balls a hair the way the leaving group goes.
  const w = WOBBLE_TIME * half;
  const nudge = s < w ? WOBBLE * swingAmplitude(n - 1, amp) * Math.sin((Math.PI * s) / w) : 0;
  out[2] = left ? -nudge : nudge;
  out[3] = left ? 0 : 1;
}

/**
 * Ball `i`'s angle from vertical (radians, positive swings towards +x) for a
 * `swingState`. The first `lifted` balls form the left group and the last
 * `lifted` the right; with 2 of 3 lifted the middle ball belongs to both, and
 * swings with whichever group is out.
 */
export function ballAngle(i: number, count: number, lifted: number, state: Float64Array): number {
  if (state[3] === 0) {
    if (i < lifted) {
      return -state[0];
    }
  } else if (i >= count - lifted) {
    return state[1];
  }
  return i >= lifted && i < count - lifted ? state[2] : 0;
}

/** A ball's rest x (world), the row centred on 0 with the balls touching. */
export function restX(i: number, count: number): number {
  return (2 * i - (count - 1)) * BALL_R;
}

/** Posts' x (world, ±) and the base's half-length and half-depth. */
export function postX(count: number): number {
  return count * BALL_R + POST_MARGIN;
}
export function baseHalf(count: number): [number, number] {
  return [postX(count) + BASE_OVERHANG, PIVOT_Z + BASE_OVERHANG];
}

/** The view's rotation: cos and sin of the yaw (signed by side) and of the pitch. */
export interface CradleView {
  side: 1 | -1;
  cy: number;
  sy: number;
  cp: number;
  sp: number;
}

export function createView(side: 1 | -1): CradleView {
  const yaw = side * YAW;
  return { side, cy: Math.cos(yaw), sy: Math.sin(yaw), cp: Math.cos(PITCH), sp: Math.sin(PITCH) };
}

/** Projects world (x, y, z) to view (x, y, depth towards the viewer) into out[o..o+2]. */
export function project(
  v: CradleView,
  x: number,
  y: number,
  z: number,
  out: ArrayLike<number> & { [i: number]: number },
  o = 0,
): void {
  const x1 = x * v.cy + z * v.sy;
  const z1 = -x * v.sy + z * v.cy;
  out[o] = x1;
  out[o + 1] = y * v.cp - z1 * v.sp;
  out[o + 2] = y * v.sp + z1 * v.cp;
}

/** A world direction rotated into view space (out[o..o+2]). */
export const rotateDir = project;

/**
 * The world point on the plane y = `h` seen at view (x, y): the inverse of
 * `project` along the view direction. Mirrors the shader's `onPlane`.
 */
export function onPlane(v: CradleView, vx: number, vy: number, h: number, out: Float64Array): void {
  const z1 = (h * v.cp - vy) / v.sp;
  out[0] = vx * v.cy - z1 * v.sy;
  out[1] = vx * v.sy + z1 * v.cy;
}

export interface CradleLayout {
  side: 1 | -1;
  /** Height units per cradle unit. */
  unit: number;
  /** Screen position of the world origin (height units). */
  ox: number;
  oy: number;
  /** Pass bounds: x0, y0, x1, y1 (height units). */
  box: [number, number, number, number];
}

export const createLayout = (): CradleLayout => ({
  side: 1,
  unit: CRADLE_UNIT,
  ox: 0,
  oy: 0,
  box: [0, 0, 0, 0],
});

const corner3 = new Float64Array(3);

/**
 * The view bounds [minX, minY, maxX, maxY] (cradle units) of everything the
 * cradle draws for `count` balls: the base, the frame and the full swing.
 */
export function viewBounds(v: CradleView, count: number, out: Float64Array): void {
  const [bx, bz] = baseHalf(count);
  out[0] = out[1] = Infinity;
  out[2] = out[3] = -Infinity;
  for (let k = 0; k < 8; k++) {
    project(v, k & 1 ? bx : -bx, k & 2 ? PIVOT_Y + ROD_R : 0, k & 4 ? bz : -bz, corner3);
    out[0] = Math.min(out[0], corner3[0]);
    out[1] = Math.min(out[1], corner3[1]);
    out[2] = Math.max(out[2], corner3[0]);
    out[3] = Math.max(out[3], corner3[1]);
  }
}

const bounds = new Float64Array(4);

/** Lays the cradle out in its corner (the view's side) of an `aspect`-wide frame. */
export function cradleLayout(
  aspect: number,
  size: number,
  count: number,
  view: CradleView,
  out: CradleLayout,
): CradleLayout {
  const side = view.side;
  const s = Number.isFinite(size) ? clamp(size, SIZE_RANGE[0], SIZE_RANGE[1]) : 1;
  viewBounds(view, count, bounds);
  const span = bounds[2] - bounds[0];
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const u = Math.min(CRADLE_UNIT * s, (MAX_WIDTH * a) / span);
  out.side = side;
  out.unit = u;
  out.ox = side > 0 ? a - EDGE_MARGIN - bounds[2] * u : EDGE_MARGIN - bounds[0] * u;
  out.oy = SEAT_Y - bounds[1] * u;
  out.box[0] = out.ox + (bounds[0] - BOX_PAD) * u;
  out.box[1] = out.oy + (bounds[1] - BOX_PAD) * u;
  out.box[2] = out.ox + (bounds[2] + BOX_PAD) * u;
  out.box[3] = out.oy + (bounds[3] + BOX_PAD) * u;
  return out;
}

/** Sorts `order[0..count)` (ball indices) by `depth`, farthest (smallest) first. In place. */
export function sortByDepth(depth: ArrayLike<number>, count: number, order: Int32Array): void {
  for (let i = 0; i < count; i++) {
    order[i] = i;
  }
  for (let i = 1; i < count; i++) {
    const k = order[i];
    let j = i - 1;
    while (j >= 0 && depth[order[j]] > depth[k]) {
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = k;
  }
}

/** One environment light: a soft rectangle seen in reflections. */
export interface EnvLight {
  /** World direction towards it, for the right-hand corner (x mirrors on the left). */
  dir: readonly [number, number, number];
  /** Half-width and half-height (tangent of the half-angle) and edge softness. */
  size: readonly [number, number, number];
  color: string;
  intensity: number;
  /** Window mullions across it (0 for none). */
  bars: number;
}

export interface ScenePalette {
  /** Background: wall top and bottom, desk at its back edge and at the frame's bottom. */
  wallTop: string;
  wallBottom: string;
  deskFar: string;
  deskNear: string;
  /** The desk's back edge (height units) and how soft it is (a studio sweep has none). */
  deskY: number;
  deskSoft: number;
  /** A soft pool of light: colour, strength, centre from the outer edge (x, y) and radius. */
  glow: string;
  glowStrength: number;
  glowAt: readonly [number, number, number];
  /** The reflected environment: sky above, horizon, and the desk below. */
  envTop: string;
  envHorizon: string;
  envDesk: string;
  /** The base and frame colour. */
  frame: string;
  lights: readonly [EnvLight, EnvLight];
}

export const SCENES: Readonly<Record<CradleScene, ScenePalette>> = {
  studio: {
    wallTop: "#3c3e42",
    wallBottom: "#6d7075",
    deskFar: "#73767b",
    deskNear: "#55585c",
    deskY: 0.2,
    deskSoft: 0.12,
    glow: "#e8ecf0",
    glowStrength: 0.12,
    glowAt: [0.5, 0.35, 0.6],
    envTop: "#7d8187",
    envHorizon: "#a9adb2",
    envDesk: "#5d6064",
    frame: "#1d1e21",
    lights: [
      { dir: [0.45, 0.75, 0.5], size: [0.6, 0.35, 0.08], color: "#ffffff", intensity: 3, bars: 0 },
      {
        dir: [-0.85, 0.25, 0.45],
        size: [0.07, 0.7, 0.04],
        color: "#f2f5ff",
        intensity: 2.5,
        bars: 0,
      },
    ],
  },
  lamp: {
    wallTop: "#120e0b",
    wallBottom: "#2a2018",
    deskFar: "#3d2817",
    deskNear: "#24170d",
    deskY: 0.16,
    deskSoft: 0.006,
    glow: "#ffcf8f",
    glowStrength: 0.45,
    glowAt: [0.3, 0.12, 0.45],
    envTop: "#1c1612",
    envHorizon: "#3b2c1f",
    envDesk: "#5a3a22",
    frame: "#1a1512",
    lights: [
      { dir: [0.5, 0.85, 0.2], size: [0.11, 0.11, 0.05], color: "#ffd59a", intensity: 9, bars: 0 },
      {
        dir: [-0.7, 0.2, 0.65],
        size: [0.32, 0.2, 0.08],
        color: "#8ea6c4",
        intensity: 0.7,
        bars: 0,
      },
    ],
  },
  office: {
    wallTop: "#58616b",
    wallBottom: "#828b93",
    deskFar: "#8a857c",
    deskNear: "#625e57",
    deskY: 0.16,
    deskSoft: 0.006,
    glow: "#eef4ff",
    glowStrength: 0.2,
    glowAt: [0.15, 0.6, 0.7],
    envTop: "#8e9ba8",
    envHorizon: "#b8c1c9",
    envDesk: "#7d786f",
    frame: "#202326",
    lights: [
      {
        dir: [-0.45, 0.35, 0.82],
        size: [0.55, 0.4, 0.06],
        color: "#eef4ff",
        intensity: 2.4,
        bars: 2,
      },
      { dir: [0.1, 0.95, 0.3], size: [0.5, 0.12, 0.06], color: "#ffffff", intensity: 1.6, bars: 0 },
    ],
  },
};

const isCradleScene = (v: string): v is CradleScene => Object.hasOwn(SCENES, v);

export function sceneOf(id: string): ScenePalette {
  return isCradleScene(id) ? SCENES[id] : SCENES.studio;
}

/** Ball material: reflectance tint at normal incidence, diffuse base colour, extra glint. */
export interface Finish {
  f0: readonly [number, number, number];
  base: readonly [number, number, number];
  glint: number;
}

export const FINISHES: Readonly<Record<CradleFinish, Finish>> = {
  chrome: { f0: [0.9, 0.91, 0.93], base: [0.05, 0.05, 0.05], glint: 1 },
  brass: { f0: [0.95, 0.72, 0.4], base: [0.08, 0.05, 0.02], glint: 1 },
  glass: { f0: [0.05, 0.05, 0.05], base: [0.008, 0.008, 0.01], glint: 1.6 },
};

const isCradleFinish = (v: string): v is CradleFinish => Object.hasOwn(FINISHES, v);

export function finishOf(id: string): Finish {
  return isCradleFinish(id) ? FINISHES[id] : FINISHES.chrome;
}

/** Side of a `corner` select value: +1 bottom right, -1 bottom left. */
export function cornerSide(corner: string): 1 | -1 {
  return corner === "left" ? -1 : 1;
}
