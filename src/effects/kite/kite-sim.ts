/**
 * Kite on a Breezy Day model: the kite's figure-eight wander with gusts, its pose,
 * the three kite shapes, the tail chain, the string's catenary, and the writers that
 * fill the triangle and streak instance data.
 *
 * Units are frame heights: x to the right from the left edge (0..aspect), y up from
 * the bottom (the top edge is y = 1), z towards the viewer. The view is orthographic.
 * The writers convert to device pixels, y down, for the renderers.
 */
import { hexToUnitRgb, type Rgb } from "../color";
import type { COLOUR_OPTIONS, CORNER_OPTIONS, KITE_OPTIONS } from "./kite.meta";
import { approach, clamp } from "../math";
import { hash32 } from "../noise";
import { STREAK_FLOATS } from "../streaks";

export type KiteKind = (typeof KITE_OPTIONS)[number]["value"];
export type KiteColours = (typeof COLOUR_OPTIONS)[number]["value"];
export type KiteCorner = (typeof CORNER_OPTIONS)[number]["value"];

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * A kite in its own frame: x right, y towards the nose, z towards the viewer, in
 * units of `KITE_SIZE`. Panels are triangles with a palette slot each, grouped
 * into flat faces (one for the flat kites, eight for the box kite).
 */
export interface KiteShape {
  /** Points, xyz triples. */
  readonly points: Float64Array;
  /** Triangles, three point indices each. */
  readonly tris: Int32Array;
  /**
   * Per triangle: bit k set when edge k (vertex k to vertex k + 1) is an outer edge,
   * anti-aliased. Inner edges, shared with a neighbour, overlap it slightly instead.
   */
  readonly edges: Int32Array;
  /** Per triangle: palette slot, 0..3. */
  readonly slot: Int32Array;
  /** Per triangle: its face. */
  readonly face: Int32Array;
  /** Per face: outward unit normal, then centre (six floats). */
  readonly faces: Float64Array;
  readonly faceCount: number;
  /** Spars, point index pairs. */
  readonly spars: Int32Array;
  /** Where the tail is tied on, and where the string is. */
  readonly tailPoint: number;
  readonly bridlePoint: number;
  /** Tail length, frame heights. */
  readonly tailLength: number;
}

/** Frame heights per kite unit. */
export const KITE_SIZE = 0.085;

/** Triangle edge masks: bit 0 = edge 0-1, bit 1 = edge 1-2, bit 2 = edge 2-0. */
const E01 = 1;
const E12 = 2;
const E20 = 4;

interface ShapeSpec {
  points: number[];
  tris: number[];
  edges: number[];
  slot: number[];
  face: number[];
  faces: number[];
  spars: number[];
  tailPoint: number;
  bridlePoint: number;
  tailLength: number;
}

function toShape(s: ShapeSpec): KiteShape {
  return {
    points: Float64Array.from(s.points),
    tris: Int32Array.from(s.tris),
    edges: Int32Array.from(s.edges),
    slot: Int32Array.from(s.slot),
    face: Int32Array.from(s.face),
    faces: Float64Array.from(s.faces),
    faceCount: s.faces.length / 6,
    spars: Int32Array.from(s.spars),
    tailPoint: s.tailPoint,
    bridlePoint: s.bridlePoint,
    tailLength: s.tailLength,
  };
}

/** Diamond: four panels round the cross of its two spars. */
function diamond(): KiteShape {
  // 0 nose, 1 left, 2 right, 3 tail end, 4 spar cross.
  return toShape({
    points: [0, 1, 0, -0.62, 0.3, 0, 0.62, 0.3, 0, 0, -0.85, 0, 0, 0.3, 0],
    tris: [0, 1, 4, 0, 4, 2, 1, 3, 4, 4, 3, 2],
    edges: [E01, E20, E01, E12],
    slot: [0, 1, 2, 3],
    face: [0, 0, 0, 0],
    faces: [0, 0, 1, 0, 0.1, 0],
    spars: [0, 3, 1, 2],
    tailPoint: 3,
    bridlePoint: 4,
    tailLength: 0.32,
  });
}

/** Delta: two swept wings, each an inner and an outer panel, with a spine and spreader. */
function delta(): KiteShape {
  // 0 nose, 1 left tip, 2 right tip, 3 spine foot, 4 / 5 leading-edge midpoints,
  // 6 / 7 spreader ends, 8 bridle.
  return toShape({
    points: [
      0, 0.85, 0, -1.05, -0.35, 0, 1.05, -0.35, 0, 0, -0.45, 0, -0.525, 0.25, 0, 0.525, 0.25, 0,
      -0.45, -0.02, 0, 0.45, -0.02, 0, 0, 0.05, 0,
    ],
    // Left outer, left inner, right inner, right outer.
    tris: [4, 1, 3, 0, 4, 3, 0, 3, 5, 5, 3, 2],
    edges: [E01 | E12, E01, E20, E01 | E12],
    slot: [0, 1, 2, 3],
    face: [0, 0, 0, 0],
    faces: [0, 0, 1, 0, 0.1, 0],
    spars: [0, 3, 0, 1, 0, 2, 6, 7],
    tailPoint: 3,
    bridlePoint: 8,
    tailLength: 0.28,
  });
}

/** Box kite half-diagonal of its square section, and its cells' y ranges. */
const BOX_R = 0.42;
const BOX_LEVELS = [1, 0.3, -0.3, -1] as const;

/**
 * Box: two cells of a square tube, turned to show a corner. Four longerons run
 * down the corners; each cell has four faces of two triangles.
 */
function box(): KiteShape {
  const points: number[] = [];
  // Corners in xz: front, right, back, left. Point (corner k, level l) is k * 4 + l.
  const cx = [0, BOX_R, 0, -BOX_R];
  const cz = [BOX_R, 0, -BOX_R, 0];
  for (let k = 0; k < 4; k++) {
    for (const y of BOX_LEVELS) {
      points.push(cx[k], y, cz[k]);
    }
  }
  const tailPoint = points.length / 3;
  points.push(0, -1, 0);
  const bridlePoint = points.length / 3;
  points.push(0, 0, BOX_R * 0.5);
  const tris: number[] = [];
  const edges: number[] = [];
  const slot: number[] = [];
  const face: number[] = [];
  const faces: number[] = [];
  for (let c = 0; c < 2; c++) {
    for (let j = 0; j < 4; j++) {
      const k = (j + 1) % 4;
      const p0 = j * 4 + c * 2;
      const p1 = k * 4 + c * 2;
      const p2 = k * 4 + c * 2 + 1;
      const p3 = j * 4 + c * 2 + 1;
      const f = faces.length / 6;
      tris.push(p0, p1, p2, p0, p2, p3);
      edges.push(E01 | E12, E12 | E20);
      const s = c * 2 + (j % 2);
      slot.push(s, s);
      face.push(f, f);
      const nx = (cx[j] + cx[k]) / 2;
      const nz = (cz[j] + cz[k]) / 2;
      const len = Math.hypot(nx, nz);
      const yc = (BOX_LEVELS[c * 2] + BOX_LEVELS[c * 2 + 1]) / 2;
      faces.push(nx / len, 0, nz / len, nx, yc, nz);
    }
  }
  const spars: number[] = [];
  for (let k = 0; k < 4; k++) {
    spars.push(k * 4, k * 4 + 3);
  }
  return toShape({
    points,
    tris,
    edges,
    slot,
    face,
    faces,
    spars,
    tailPoint,
    bridlePoint,
    tailLength: 0.2,
  });
}

export const SHAPES: Readonly<Record<KiteKind, KiteShape>> = {
  diamond: diamond(),
  delta: delta(),
  box: box(),
};

/** The shape for a `kite` param value; unknown values fall back to the diamond. */
export function shapeFor(kind: string): KiteShape {
  return kind === "delta" || kind === "box" ? SHAPES[kind] : SHAPES.diamond;
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

export interface KitePalette {
  /** Panel colours, four slots. */
  readonly panels: readonly Rgb[];
  /** Tail band colours, cycled down the tail. */
  readonly tail: readonly Rgb[];
}

const PALETTE_HEX: Record<KiteColours, { panels: string[]; tail: string[] }> = {
  rainbow: {
    panels: ["#e8413c", "#f5c02c", "#3fae5a", "#d94a9a"],
    tail: ["#e8413c", "#f7a531", "#f4d63a", "#3fae5a", "#d94a9a"],
  },
  red: {
    panels: ["#dd3330", "#b52426", "#b52426", "#dd3330"],
    tail: ["#dd3330", "#e8604f"],
  },
  blueyellow: {
    panels: ["#1e3a8c", "#f5c829", "#f5c829", "#1e3a8c"],
    tail: ["#1e3a8c", "#f5c829"],
  },
};

const toPalette = (hex: { panels: string[]; tail: string[] }): KitePalette => ({
  panels: hex.panels.map(hexToUnitRgb),
  tail: hex.tail.map(hexToUnitRgb),
});

export const PALETTES: Readonly<Record<KiteColours, KitePalette>> = {
  rainbow: toPalette(PALETTE_HEX.rainbow),
  red: toPalette(PALETTE_HEX.red),
  blueyellow: toPalette(PALETTE_HEX.blueyellow),
};

/** The palette for a `colour` param value; unknown values fall back to rainbow. */
export function paletteFor(id: string): KitePalette {
  return id === "red" || id === "blueyellow" ? PALETTES[id] : PALETTES.rainbow;
}

// ---------------------------------------------------------------------------
// Flight path
// ---------------------------------------------------------------------------

/** Horizontal distance of the path centre from the frame's side edge (at 16:9). */
export const CORNER_INSET = 0.34;
/** Path centre height. */
export const PATH_Y = 0.73;
/** Figure-eight half-width and half-height at full wind. */
export const PATH_AX = 0.12;
export const PATH_AY = 0.07;
/** Seconds per figure-eight at wind 0.5 without gusts. */
const PATH_PERIOD = 16;
/** Height a full gust lifts the kite by. */
export const GUST_LIFT = 0.03;
/** Gust noise lattice points per second. */
const GUST_RATE = 0.11;
/** Seconds the kite takes to fly over to the other corner. */
const CORNER_SECONDS = 3.5;
/** Wind units per second the smoothed wind follows the slider at. */
const WIND_RATE = 0.35;

/** Bank (roll) limit and gain per unit of sideways acceleration. */
const ROLL_MAX = 0.55;
const BANK_GAIN = 16;
/** Yaw limit and gain per unit of sideways speed. */
const YAW_MAX = 0.45;
const YAW_GAIN = 9;
/** Small fast wobble of the fabric in the wind, radians. */
const FLUTTER = 0.025;

/** Smooth 1D value noise in [0, 1], C2 continuous (quintic fade), from lowbias32. */
export function gustNoise(t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash32(i * 2654435761) / 4294967296;
  const b = hash32((i + 1) * 2654435761) / 4294967296;
  const s = f * f * f * (f * (f * 6 - 15) + 10);
  return a + (b - a) * s;
}

/** Gust strength 0..1 at `time` seconds: mostly calm, with an occasional swell. */
export function gustAt(time: number): number {
  const g = gustNoise(time * GUST_RATE);
  const x = clamp((g - 0.5) / 0.35, 0, 1);
  return x * x * (3 - 2 * x);
}

/** Horizontal scale for narrow frames, so the kite stays in its corner. */
export function aspectScale(aspect: number): number {
  return clamp(aspect / (16 / 9), 0.4, 1);
}

/** The pose that sets where and how the kite is drawn. */
export interface KitePose {
  x: number;
  y: number;
  roll: number;
  pitch: number;
  yaw: number;
  gust: number;
}

export interface KiteState {
  /** Path phase, radians; unwrapped float64 (the wander terms are not 2π-periodic). */
  phase: number;
  /** Seconds since creation, float64, for gusts and flutter. */
  time: number;
  /** Smoothed wind 0..1; NaN until the first step. */
  wind: number;
  /** Corner blend: 0 = left, 1 = right (eased when drawn); NaN until the first step. */
  side: number;
  readonly pose: KitePose;
  /** Tail chain, xy pairs, and its velocities. */
  readonly tail: Float64Array;
  readonly tailV: Float64Array;
  /** Whether the tail has been laid out. */
  tailReady: boolean;
  /** Tail ripple and twist phases, wrapped to 2π. */
  ripple: number;
  twist: number;
  /** World positions of the current shape's points (xyz), and its rotation (row-major 3x3). */
  readonly world: Float64Array;
  readonly rot: Float64Array;
  /** String anchor, off-screen. */
  anchorX: number;
  anchorY: number;
  /** Horizontal wind direction for the tail: +1 blows right, -1 left. */
  windDir: number;
}

/** Points in the tail chain. */
export const TAIL_POINTS = 32;
const MAX_SHAPE_POINTS = 32;

export function createKiteState(): KiteState {
  return {
    phase: 0,
    time: 0,
    wind: Number.NaN,
    side: Number.NaN,
    pose: { x: 0, y: 0, roll: 0, pitch: 0, yaw: 0, gust: 0 },
    tail: new Float64Array(TAIL_POINTS * 2),
    tailV: new Float64Array(TAIL_POINTS * 2),
    tailReady: false,
    ripple: 0,
    twist: 0,
    world: new Float64Array(MAX_SHAPE_POINTS * 3),
    rot: new Float64Array(9),
    anchorX: 0,
    anchorY: 0,
    windDir: -1,
  };
}

const ease = (s: number) => s * s * (3 - 2 * s);

/** Path angular speed, radians per second, for a wind and gust. */
export function pathRate(wind: number, gust: number): number {
  return (TAU / PATH_PERIOD) * (0.55 + 0.9 * wind) * (1 + 0.6 * gust);
}

/**
 * Fills `pose` for path phase `phase` (radians, unwrapped), path rate `rate`
 * (radians per second), `time` (seconds), wind 0..1, eased corner blend `side`
 * (0 left, 1 right) and frame aspect. A pure function of its inputs.
 */
export function poseAt(
  pose: KitePose,
  phase: number,
  rate: number,
  time: number,
  wind: number,
  side: number,
  aspect: number,
): KitePose {
  const k = aspectScale(aspect);
  const inset = CORNER_INSET * k;
  const cx = inset + (aspect - 2 * inset) * side;
  const ax = PATH_AX * k * (0.7 + 0.3 * wind);
  const ay = PATH_AY * (0.6 + 0.4 * wind);
  const gust = gustAt(time);
  // A figure-eight (x at the path rate, y at twice it), with a slow wander so no
  // two loops are quite the same.
  const s1 = Math.sin(phase);
  const s2 = Math.sin(2 * phase);
  const w1 = 0.37 * phase + 1;
  const w2 = 0.53 * phase;
  const x = cx + ax * s1 + 0.02 * k * Math.sin(w1);
  const y = PATH_Y - 0.04 * (1 - wind) + ay * s2 + 0.015 * Math.sin(w2) + GUST_LIFT * gust;
  // Velocity and acceleration from the path derivatives (the rate's own drift is slow).
  const dx = ax * Math.cos(phase) + 0.02 * k * 0.37 * Math.cos(w1);
  const ddx = -ax * s1 - 0.02 * k * 0.37 * 0.37 * Math.sin(w1);
  const vx = dx * rate;
  const accX = ddx * rate * rate;
  const flutter =
    FLUTTER *
    (0.4 + 0.6 * wind + gust) *
    (Math.sin(TAU * 0.9 * time) + 0.5 * Math.sin(TAU * 1.37 * time + 1.3));
  pose.x = x;
  pose.y = y;
  // Banks into each turn: the top leans towards the centre of the curve.
  pose.roll = ROLL_MAX * Math.tanh((-accX * BANK_GAIN) / ROLL_MAX) + flutter;
  pose.yaw = YAW_MAX * Math.tanh((vx * YAW_GAIN) / YAW_MAX) + 0.5 * flutter;
  // A stronger wind holds the kite more upright to the viewer; gusts lift its nose.
  pose.pitch = 0.5 - 0.2 * wind - 0.12 * gust;
  pose.gust = gust;
  return pose;
}

/** Row-major rotation Rz(roll) · Ry(yaw) · Rx(-pitch), so the nose tips away from the viewer. */
export function poseMatrix(out: Float64Array, roll: number, pitch: number, yaw: number) {
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // Rx(-pitch): y' = y cp + z sp, z' = -y sp + z cp.
  // Ry(yaw) · Rx(-pitch):
  const m00 = cy;
  const m01 = -sy * sp;
  const m02 = sy * cp;
  const m10 = 0;
  const m11 = cp;
  const m12 = sp;
  const m20 = -sy;
  const m21 = -cy * sp;
  const m22 = cy * cp;
  out[0] = cr * m00 - sr * m10;
  out[1] = cr * m01 - sr * m11;
  out[2] = cr * m02 - sr * m12;
  out[3] = sr * m00 + cr * m10;
  out[4] = sr * m01 + cr * m11;
  out[5] = sr * m02 + cr * m12;
  out[6] = m20;
  out[7] = m21;
  out[8] = m22;
  return out;
}

/** Writes the shape's points in world space into `world` (xyz triples). */
export function placeShape(
  world: Float64Array,
  rot: Float64Array,
  shape: KiteShape,
  pose: KitePose,
) {
  const p = shape.points;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    world[i] = pose.x + KITE_SIZE * (rot[0] * x + rot[1] * y + rot[2] * z);
    world[i + 1] = pose.y + KITE_SIZE * (rot[3] * x + rot[4] * y + rot[5] * z);
    world[i + 2] = KITE_SIZE * (rot[6] * x + rot[7] * y + rot[8] * z);
  }
}

// ---------------------------------------------------------------------------
// Tail
// ---------------------------------------------------------------------------

/** Tail drag towards the wind's speed, per second, and gravity. */
const TAIL_DRAG = 3;
const TAIL_GRAVITY = 0.8;
/** Wind speed the tail streams in, frame heights per second, at wind 0 and its gain. */
const TAIL_WIND0 = 0.08;
const TAIL_WIND1 = 0.18;
/** Longest physics substep, seconds, and longest step taken at all. */
const SUBSTEP = 1 / 60;
const MAX_DT = 0.1;

/** Share of the next point's correction taken off each point's velocity. */
const FTL_DAMPING = 0.9;

const tailBefore = new Float64Array(TAIL_POINTS * 2);
const tailFix = new Float64Array(TAIL_POINTS * 2);

/** Wind speed for the tail at a wind and gust. */
function tailWind(wind: number, gust: number): number {
  return TAIL_WIND0 + TAIL_WIND1 * wind * (1 + 0.8 * gust);
}

/**
 * Lays the tail out straight from (hx, hy) along its steady streaming direction,
 * at rest.
 */
export function layTail(state: KiteState, hx: number, hy: number, spacing: number) {
  const w = state.windDir * tailWind(state.wind, state.pose.gust);
  const g = -TAIL_GRAVITY / TAIL_DRAG;
  const len = Math.hypot(w, g);
  const ux = w / len;
  const uy = g / len;
  for (let i = 0; i < TAIL_POINTS; i++) {
    state.tail[i * 2] = hx + ux * spacing * i;
    state.tail[i * 2 + 1] = hy + uy * spacing * i;
    state.tailV[i * 2] = 0;
    state.tailV[i * 2 + 1] = 0;
  }
  state.tailReady = true;
}

/**
 * Advances the tail by `dt` while its head moves from (x0, y0) to (x1, y1): per
 * substep, each point is pushed by drag towards the wind and by gravity, then put
 * back at exactly `spacing` from the point before (follow the leader), and its
 * velocity set from where it really went.
 */
export function stepTail(
  state: KiteState,
  dt: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  spacing: number,
) {
  const t = state.tail;
  const v = state.tailV;
  const steps = Math.max(1, Math.ceil(dt / SUBSTEP));
  const h = dt / steps;
  const wx = state.windDir * tailWind(state.wind, state.pose.gust);
  for (let s = 1; s <= steps; s++) {
    const f = s / steps;
    t[0] = x0 + (x1 - x0) * f;
    t[1] = y0 + (y1 - y0) * f;
    if (!(h > 0)) {
      continue;
    }
    for (let i = 1; i < TAIL_POINTS; i++) {
      const o = i * 2;
      const vx = v[o] + (wx - v[o]) * TAIL_DRAG * h;
      const vy = v[o + 1] + (-v[o + 1] * TAIL_DRAG - TAIL_GRAVITY) * h;
      tailBefore[o] = t[o];
      tailBefore[o + 1] = t[o + 1];
      const x = t[o] + vx * h;
      const y = t[o + 1] + vy * h;
      const px = t[o - 2];
      const py = t[o - 1];
      const dx = x - px;
      const dy = y - py;
      const d = Math.hypot(dx, dy);
      const nx = d > 1e-9 ? px + (dx / d) * spacing : px;
      const ny = d > 1e-9 ? py + (dy / d) * spacing : py - spacing;
      tailFix[o] = nx - x;
      tailFix[o + 1] = ny - y;
      t[o] = nx;
      t[o + 1] = ny;
    }
    // Velocities from where each point went, less a share of the next point's
    // correction (Mueller et al.'s dynamic follow-the-leader): without it the
    // corrections feed back as velocity and the free end whips about.
    for (let i = 1; i < TAIL_POINTS; i++) {
      const o = i * 2;
      const nfx = i + 1 < TAIL_POINTS ? tailFix[o + 2] : 0;
      const nfy = i + 1 < TAIL_POINTS ? tailFix[o + 3] : 0;
      v[o] = (t[o] - tailBefore[o] - FTL_DAMPING * nfx) / h;
      v[o + 1] = (t[o + 1] - tailBefore[o + 1] - FTL_DAMPING * nfy) / h;
    }
  }
  t[0] = x1;
  t[1] = y1;
}

/** Ripple and twist phase speeds, radians per second, at wind 0 and their gain. */
const RIPPLE_SPEED = 2.4;
const TWIST_SPEED = 1.3;

// ---------------------------------------------------------------------------
// String
// ---------------------------------------------------------------------------

/** String anchor: this far beyond the side edge, and this high (below the frame). */
export const ANCHOR_OUT = 0.25;
export const ANCHOR_Y = -0.45;

/** Catenary parameter (horizontal tension over weight, frame heights) for a wind and gust. */
export function catenaryParam(wind: number, gust: number): number {
  return 0.6 + 2.2 * wind + 0.6 * gust;
}

/**
 * Fills `out` with `n + 1` xy points of the catenary y = a cosh((x - x0) / a) + c
 * through (x1, y1) and (x2, y2), from the first to the second, evenly spaced in x.
 * Nearly vertical spans are drawn straight.
 */
export function catenary(
  out: Float64Array,
  n: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  a: number,
) {
  const span = x2 - x1;
  if (Math.abs(span) < 1e-4) {
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      out[i * 2] = x1 + span * u;
      out[i * 2 + 1] = y1 + (y2 - y1) * u;
    }
    return out;
  }
  const x0 = (x1 + x2) / 2 - a * Math.asinh((y2 - y1) / (2 * a * Math.sinh(span / (2 * a))));
  const c = y1 - a * Math.cosh((x1 - x0) / a);
  for (let i = 0; i <= n; i++) {
    const x = x1 + span * (i / n);
    out[i * 2] = x;
    out[i * 2 + 1] = a * Math.cosh((x - x0) / a) + c;
  }
  // Exact ends, whatever the rounding.
  out[1] = y1;
  out[n * 2 + 1] = y2;
  return out;
}

/** String segments. */
export const STRING_SEGMENTS = 40;

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

/**
 * Advances the kite by `dt` seconds: smooths the wind and corner, moves along the
 * path, poses and places the shape, and steps the tail. Allocates nothing.
 */
export function stepKite(
  state: KiteState,
  dt: number,
  shape: KiteShape,
  wind: number,
  corner: string,
  aspect: number,
) {
  const step = Number.isFinite(dt) ? clamp(dt, 0, MAX_DT) : 0;
  const w = clamp(Number.isFinite(wind) ? wind : 0.5, 0, 1);
  const sideTarget = corner === "left" ? 0 : 1;
  if (Number.isNaN(state.wind)) {
    state.wind = w;
  }
  if (Number.isNaN(state.side)) {
    state.side = sideTarget;
  }
  state.wind = approach(state.wind, w, WIND_RATE * step);
  state.side = approach(state.side, sideTarget, step / CORNER_SECONDS);
  const side = ease(state.side);

  const gust = gustAt(state.time);
  const rate = pathRate(state.wind, gust);
  state.phase += rate * step;
  state.time += step;
  const pose = poseAt(state.pose, state.phase, rate, state.time, state.wind, side, aspect);
  state.windDir = 1 - 2 * side;
  state.anchorX = -ANCHOR_OUT + (aspect + 2 * ANCHOR_OUT) * side;
  state.anchorY = ANCHOR_Y;

  const tp = shape.tailPoint * 3;
  const hx0 = state.world[tp];
  const hy0 = state.world[tp + 1];
  poseMatrix(state.rot, pose.roll, pose.pitch, pose.yaw);
  placeShape(state.world, state.rot, shape, pose);
  const hx = state.world[tp];
  const hy = state.world[tp + 1];
  const spacing = shape.tailLength / (TAIL_POINTS - 1);
  if (!state.tailReady) {
    layTail(state, hx, hy, spacing);
  } else {
    stepTail(state, step, hx0, hy0, hx, hy, spacing);
  }

  const rw = 0.6 + 0.8 * state.wind;
  state.ripple = (state.ripple + RIPPLE_SPEED * rw * (1 + 0.6 * gust) * step) % TAU;
  state.twist = (state.twist + TWIST_SPEED * rw * step) % TAU;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/**
 * Floats per triangle instance: a.xy, b.xy | c.xy, outer-edge mask, unused |
 * premultiplied rgba. Positions in device pixels, y down.
 */
export const TRI_FLOATS = 12;
/** Tail triangles, and the most a kite has. */
export const TAIL_TRIS = (TAIL_POINTS - 1) * 2;
export const MAX_KITE_TRIS = 16;
export const MAX_TRIS = TAIL_TRIS + MAX_KITE_TRIS;
/** Streaks: spars that show through the fabric, and spars in front plus the string. */
export const MAX_BACK_STREAKS = 4;
export const MAX_FRONT_STREAKS = 4 + STRING_SEGMENTS;

/** Tail half-width, ripple amplitude (frame heights), waves along the tail, and twist. */
const TAIL_HALF_WIDTH = 0.0065;
const RIPPLE_AMP = 0.012;
const RIPPLE_WAVES = 2.3;
const TWIST_AMP = 1.1;
const TWIST_WAVES = 1.4;
/** Tail segments per colour band. */
const BAND = 3;
/** Fabric opacity: the sky shows faintly through it. */
export const FABRIC_ALPHA = 0.88;
/** Unit vector towards the sun: high up, a little right, behind the kite. */
const SUN = (() => {
  const v = [0.3, 0.55, -0.78];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l] as const;
})();
const SPAR_COLOUR: Rgb = [0.2, 0.15, 0.12];
const STRING_COLOUR: Rgb = [0.95, 0.94, 0.9];
/** Spar and string half-widths, px at 1080p. */
const SPAR_HALF_WIDTH = 1.4;
const STRING_HALF_WIDTH = 0.6;

const tailCentre = new Float64Array(TAIL_POINTS * 2);
const tailHalf = new Float64Array(TAIL_POINTS);
const tailShade = new Float64Array(TAIL_POINTS);
const faceOrder = new Int32Array(16);
const faceDepth = new Float64Array(16);
const faceLight = new Float64Array(16);
const stringPts = new Float64Array((STRING_SEGMENTS + 1) * 2);

function putTri(
  data: Float32Array,
  n: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  mask: number,
  r: number,
  g: number,
  b: number,
  a: number,
) {
  const o = n * TRI_FLOATS;
  data[o] = ax;
  data[o + 1] = ay;
  data[o + 2] = bx;
  data[o + 3] = by;
  data[o + 4] = cx;
  data[o + 5] = cy;
  data[o + 6] = mask;
  data[o + 7] = 0;
  data[o + 8] = r * a;
  data[o + 9] = g * a;
  data[o + 10] = b * a;
  data[o + 11] = a;
}

/**
 * Writes the tail ribbon as `TAIL_TRIS` opaque triangles from instance `first`:
 * the chain, rippled sideways by a wave travelling away from the kite and twisted
 * so its width breathes, in colour bands. `height` is the frame height in px.
 * Returns the number written.
 */
export function writeTail(
  data: Float32Array,
  first: number,
  state: KiteState,
  palette: KitePalette,
  height: number,
): number {
  const t = state.tail;
  const amp = RIPPLE_AMP * (0.5 + 0.6 * state.wind + 0.6 * state.pose.gust);
  for (let i = 0; i < TAIL_POINTS; i++) {
    const o = i * 2;
    const a = Math.max(0, i - 1);
    const b = Math.min(TAIL_POINTS - 1, i + 1);
    let tx = t[b * 2] - t[a * 2];
    let ty = t[b * 2 + 1] - t[a * 2 + 1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const s = i / (TAIL_POINTS - 1);
    const off = amp * Math.pow(s, 0.8) * Math.sin(TAU * RIPPLE_WAVES * s - state.ripple);
    tailCentre[o] = t[o] - ty * off;
    tailCentre[o + 1] = t[o + 1] + tx * off;
    const tw = Math.cos(TWIST_AMP * s * Math.sin(TAU * TWIST_WAVES * s - state.twist));
    tailHalf[i] = TAIL_HALF_WIDTH * (0.3 + 0.7 * Math.abs(tw)) * (1 - 0.25 * s);
    tailShade[i] = (0.8 + 0.2 * Math.abs(tw)) * (tw < 0 ? 0.85 : 1);
  }
  let n = first;
  let lx0 = 0;
  let ly0 = 0;
  let rx0 = 0;
  let ry0 = 0;
  const tail = palette.tail;
  for (let i = 0; i < TAIL_POINTS; i++) {
    const o = i * 2;
    const a = Math.max(0, i - 1);
    const b = Math.min(TAIL_POINTS - 1, i + 1);
    let tx = tailCentre[b * 2] - tailCentre[a * 2];
    let ty = tailCentre[b * 2 + 1] - tailCentre[a * 2 + 1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const hw = tailHalf[i];
    // Edges in px, y down.
    const lx = (tailCentre[o] - ty * hw) * height;
    const ly = (1 - (tailCentre[o + 1] + tx * hw)) * height;
    const rx = (tailCentre[o] + ty * hw) * height;
    const ry = (1 - (tailCentre[o + 1] - tx * hw)) * height;
    if (i > 0) {
      const c = tail[Math.floor((i - 1) / BAND) % tail.length];
      const k = (tailShade[i - 1] + tailShade[i]) / 2;
      const last = i === TAIL_POINTS - 1;
      // Quad (l0, r0, r1, l1): the long sides are outer, the ends and diagonal inner,
      // except the tail's free end.
      putTri(data, n++, lx0, ly0, rx0, ry0, rx, ry, E12, c[0] * k, c[1] * k, c[2] * k, 1);
      putTri(
        data,
        n++,
        lx0,
        ly0,
        rx,
        ry,
        lx,
        ly,
        E20 | (last ? E12 : 0),
        c[0] * k,
        c[1] * k,
        c[2] * k,
        1,
      );
    }
    lx0 = lx;
    ly0 = ly;
    rx0 = rx;
    ry0 = ry;
  }
  return n - first;
}

/** Shading of a face with world normal (nx, ny, nz): front light, plus the sun glowing through. */
export function fabricLight(nx: number, ny: number, nz: number): number {
  // The side the viewer sees.
  const sgn = nz < 0 ? -1 : 1;
  const d = sgn * (nx * SUN[0] + ny * SUN[1] + nz * SUN[2]);
  const front = Math.max(d, 0);
  const through = Math.max(-d, 0);
  return 0.8 + 0.2 * front + 0.5 * through * through;
}

/** Kite triangle counts from the last `writeKite`: faces behind, then in front. */
export const kiteCounts = { back: 0, front: 0 };

/**
 * Writes the kite's panels from instance `first`, faces turned away first, each
 * group far to near. Sets `kiteCounts`. Returns the number written.
 */
export function writeKite(
  data: Float32Array,
  first: number,
  state: KiteState,
  shape: KiteShape,
  palette: KitePalette,
  height: number,
): number {
  const rot = state.rot;
  const world = state.world;
  const fc = shape.faceCount;
  for (let f = 0; f < fc; f++) {
    const o = f * 6;
    const nx = shape.faces[o];
    const ny = shape.faces[o + 1];
    const nz = shape.faces[o + 2];
    const wx = rot[0] * nx + rot[1] * ny + rot[2] * nz;
    const wy = rot[3] * nx + rot[4] * ny + rot[5] * nz;
    const wz = rot[6] * nx + rot[7] * ny + rot[8] * nz;
    faceLight[f] = fabricLight(wx, wy, wz);
    const cx = shape.faces[o + 3];
    const cy = shape.faces[o + 4];
    const cz = shape.faces[o + 5];
    // Depth of the centre; faces turned away sort before all the others.
    faceDepth[f] = rot[6] * cx + rot[7] * cy + rot[8] * cz + (wz < 0 ? -100 : 0);
    // Insertion sort by depth, far first.
    let j = f;
    while (j > 0 && faceDepth[faceOrder[j - 1]] > faceDepth[f]) {
      faceOrder[j] = faceOrder[j - 1];
      j--;
    }
    faceOrder[j] = f;
  }
  let n = first;
  let back = 0;
  const tris = shape.tris;
  const triCount = tris.length / 3;
  for (let k = 0; k < fc; k++) {
    const f = faceOrder[k];
    const light = faceLight[f];
    for (let t = 0; t < triCount; t++) {
      if (shape.face[t] !== f) {
        continue;
      }
      const a = tris[t * 3] * 3;
      const b = tris[t * 3 + 1] * 3;
      const c = tris[t * 3 + 2] * 3;
      const col = palette.panels[shape.slot[t]];
      putTri(
        data,
        n++,
        world[a] * height,
        (1 - world[a + 1]) * height,
        world[b] * height,
        (1 - world[b + 1]) * height,
        world[c] * height,
        (1 - world[c + 1]) * height,
        shape.edges[t],
        Math.min(1, col[0] * light + 0.06 * Math.max(0, light - 0.9)),
        Math.min(1, col[1] * light + 0.05 * Math.max(0, light - 0.9)),
        Math.min(1, col[2] * light + 0.03 * Math.max(0, light - 0.9)),
        FABRIC_ALPHA,
      );
      if (faceDepth[f] < -50) {
        back++;
      }
    }
  }
  kiteCounts.back = back;
  kiteCounts.front = n - first - back;
  return n - first;
}

function putStreak(
  data: Float32Array,
  n: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  c: Rgb,
  hw: number,
) {
  const o = n * STREAK_FLOATS;
  data[o] = x0;
  data[o + 1] = y0;
  data[o + 2] = x1;
  data[o + 3] = y1;
  data[o + 4] = c[0];
  data[o + 5] = c[1];
  data[o + 6] = c[2];
  data[o + 7] = hw;
}

/** Streak counts from the last `writeLines`: spars behind the fabric, and in front plus string. */
export const lineCounts = { back: 0, front: 0 };

/**
 * Writes the spars (those behind the kite's centre into `back`, the rest into
 * `front`) and then the string, from the bridle to the anchor, into `front`.
 * `scale` is height / 1080. Sets `lineCounts`.
 */
export function writeLines(
  back: Float32Array,
  front: Float32Array,
  state: KiteState,
  shape: KiteShape,
  height: number,
  scale: number,
) {
  const world = state.world;
  const sp = shape.spars;
  let nb = 0;
  let nf = 0;
  const hw = SPAR_HALF_WIDTH * scale;
  for (let i = 0; i < sp.length; i += 2) {
    const a = sp[i] * 3;
    const b = sp[i + 1] * 3;
    const x0 = world[a] * height;
    const y0 = (1 - world[a + 1]) * height;
    const x1 = world[b] * height;
    const y1 = (1 - world[b + 1]) * height;
    // Only the box kite has faces behind others; its rear longerons go behind the
    // front faces. A flat kite's spars are all on the side the viewer sees.
    if (shape.faceCount > 1 && world[a + 2] + world[b + 2] < -1e-3 * KITE_SIZE) {
      putStreak(back, nb++, x0, y0, x1, y1, SPAR_COLOUR, hw);
    } else {
      putStreak(front, nf++, x0, y0, x1, y1, SPAR_COLOUR, hw);
    }
  }
  const br = shape.bridlePoint * 3;
  catenary(
    stringPts,
    STRING_SEGMENTS,
    world[br],
    world[br + 1],
    state.anchorX,
    state.anchorY,
    catenaryParam(state.wind, state.pose.gust),
  );
  const shw = STRING_HALF_WIDTH * scale;
  for (let i = 0; i < STRING_SEGMENTS; i++) {
    const o = i * 2;
    putStreak(
      front,
      nf++,
      stringPts[o] * height,
      (1 - stringPts[o + 1]) * height,
      stringPts[o + 2] * height,
      (1 - stringPts[o + 3]) * height,
      STRING_COLOUR,
      shw,
    );
  }
  lineCounts.back = nb;
  lineCounts.front = nf;
}
