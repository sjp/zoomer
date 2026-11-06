/**
 * Hanging Mobile model: a balanced tree of wire arms built from a seed, turned and
 * swung by a slow "draught", and posed in 3D.
 *
 * Units are frame heights: x to the right from the left edge, y up from the bottom
 * (the top edge is y = 1), z towards the viewer. The view is orthographic, so a
 * point's screen position is just (x, y); z only sets drawing order and how far the
 * shadow falls from the shape on the wall behind.
 *
 * Each arm hangs from a wire at its pivot and carries two ends, each a flat shape
 * or a smaller arm (a sub-mobile) hanging from its own wire. The pivot sits where
 * the torques balance, with each subtree's mass the sum of its shapes' areas.
 */
import { MAX_LEVELS, MIN_LEVELS, type MobilePaletteId } from "./mobile.meta";
import { hexToUnitRgb, type Rgb } from "./color";
import { approach, clamp, smoothstep } from "./math";
import { createRng } from "./noise";
import { lookup } from "./lookup";

export const SHAPE_DISC = 0;
export const SHAPE_PETAL = 1;
export const SHAPE_CRESCENT = 2;
export type ShapeKind = typeof SHAPE_DISC | typeof SHAPE_PETAL | typeof SHAPE_CRESCENT;

/**
 * Petal: a vesica (the overlap of two discs offset by ±PETAL_OFFSET in x) with tips
 * at (0, ±1) and half-width PETAL_HALF_WIDTH, so it fits the unit disc.
 */
export const PETAL_HALF_WIDTH = 0.42;
export const PETAL_OFFSET = (1 - PETAL_HALF_WIDTH * PETAL_HALF_WIDTH) / (2 * PETAL_HALF_WIDTH);
export const PETAL_RADIUS = PETAL_OFFSET + PETAL_HALF_WIDTH;
/** Crescent: the unit disc minus a disc of this radius centred here. */
export const CRESCENT_CUT_X = 0.38;
export const CRESCENT_CUT_Y = 0.22;
export const CRESCENT_CUT_R = 0.8;

/** Area of the overlap of two discs of radii r1 and r2 whose centres are d apart. */
export function discOverlap(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) {
    return 0;
  }
  if (d <= Math.abs(r1 - r2)) {
    return Math.PI * Math.min(r1, r2) ** 2;
  }
  const a1 = Math.acos(clamp((d * d + r1 * r1 - r2 * r2) / (2 * d * r1), -1, 1));
  const a2 = Math.acos(clamp((d * d + r2 * r2 - r1 * r1) / (2 * d * r2), -1, 1));
  const k = Math.sqrt(Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)));
  return r1 * r1 * a1 + r2 * r2 * a2 - k / 2;
}

const SHAPE_AREAS: readonly number[] = [
  Math.PI,
  discOverlap(PETAL_RADIUS, PETAL_RADIUS, 2 * PETAL_OFFSET),
  Math.PI - discOverlap(1, CRESCENT_CUT_R, Math.hypot(CRESCENT_CUT_X, CRESCENT_CUT_Y)),
];

/** Area of a shape of the given kind with radius 1. */
export function shapeArea(kind: ShapeKind): number {
  return SHAPE_AREAS[kind];
}

/**
 * Signed distance (negative inside) to a shape of radius 1, in its own plane: the
 * JS twin of `shapeDist` in the shader, used by the tests.
 */
export function shapeSdf(kind: ShapeKind, x: number, y: number): number {
  const disc = Math.hypot(x, y) - 1;
  if (kind === SHAPE_DISC) {
    return disc;
  }
  if (kind === SHAPE_PETAL) {
    return Math.max(
      Math.hypot(x - PETAL_OFFSET, y) - PETAL_RADIUS,
      Math.hypot(x + PETAL_OFFSET, y) - PETAL_RADIUS,
    );
  }
  return Math.max(disc, CRESCENT_CUT_R - Math.hypot(x - CRESCENT_CUT_X, y - CRESCENT_CUT_Y));
}

/** Shape colours, five slots per palette; slot 0 is the most common. */
const PALETTE_HEX: Record<MobilePaletteId, readonly string[]> = {
  primary: ["#c4321f", "#1c1b1a", "#e6b11e", "#22509c", "#f3f0e7"],
  mono: ["#1c1c1c", "#4b4b4b", "#8e8e8e", "#cbcbca", "#f5f5f2"],
  pastel: ["#e8a3a0", "#9fd1bd", "#f1db94", "#a5c1e6", "#f8f4ea"],
  earth: ["#b5512a", "#3a2d24", "#d49a36", "#6a7a3b", "#e9dcc2"],
};
const PALETTES: Record<MobilePaletteId, readonly Rgb[]> = {
  primary: PALETTE_HEX.primary.map(hexToUnitRgb),
  mono: PALETTE_HEX.mono.map(hexToUnitRgb),
  pastel: PALETTE_HEX.pastel.map(hexToUnitRgb),
  earth: PALETTE_HEX.earth.map(hexToUnitRgb),
};
export const PALETTE_SLOTS = 5;
const SLOT_WEIGHTS = [0.3, 0.2, 0.2, 0.18, 0.12];

/** The palette's colours (0..1), falling back to Primary for an unknown id. */
export function paletteFor(id: string): readonly Rgb[] {
  return lookup(PALETTES, id, "primary");
}

/** The most arms and shapes any tree has. */
export const MAX_ARMS = 11;
export const MAX_SHAPES = MAX_ARMS + 1;
/** Straight segments per arm wire. */
export const ARM_SEGMENTS = 8;
/** Wire segments: each arm's curve and hanging wire, and each shape's stub. */
export const MAX_WIRES = MAX_ARMS * (ARM_SEGMENTS + 1) + MAX_SHAPES;
/** Floats per wire segment in `writeWires`: x, y, z of each end. */
export const WIRE_FLOATS = 6;

/** Largest swing of a hanging wire, as horizontal travel per unit of wire length. */
export const SWING_MAX = 0.1;
/** Clearance kept between parts that can turn past each other. */
const MARGIN = 0.012;
/** Shortest hanging wire above a sub-mobile. */
const DROP_MIN = 0.03;
/** Wire from the ceiling (the top edge) to the top arm's pivot, at least. */
const TOP_DROP = 0.05;
/** Gap between the region and the frame edge. */
const EDGE = 0.035;
/** The mobile is never scaled up by more than this to fill its region. */
const MAX_FIT = 1.15;
/** Shapes hang this many radii below their wire tip. */
const STUB = 0.85;

interface Region {
  /** Hook x, and the region's half-width about it. */
  x: number;
  halfWidth: number;
  /** Region height down from the top edge. */
  height: number;
  /** Arm-length multiplier: Across spreads the mobile wider. */
  spread: number;
  /** See Builder.stretch. */
  stretch: number;
}

/** Where a mobile hangs for a side and frame aspect (width / height). */
export function regionFor(side: string, aspect: number): Region {
  const maxHalf = Math.max(0.1, aspect / 2 - EDGE);
  if (side === "across") {
    return {
      x: aspect / 2,
      halfWidth: Math.min(maxHalf, 0.8),
      height: 0.44,
      spread: 1.7,
      stretch: 2,
    };
  }
  const halfWidth = Math.min(maxHalf, 0.31);
  const x = side === "left" ? EDGE + halfWidth : aspect - EDGE - halfWidth;
  return { x, halfWidth, height: 0.52, spread: 1, stretch: 1.4 };
}

export interface MobileShape {
  kind: ShapeKind;
  /** Radius (frame heights) and mass (area). */
  r: number;
  mass: number;
  /** Palette slot. */
  colour: number;
  /** Turn of the plate about the vertical, relative to its arm. */
  twist: number;
  /** In-plane rotation of the outline. */
  spin: number;
  /** Length of the stub wire from the arm tip down to the shape's centre. */
  stub: number;
  // Pose, written by poseMobile.
  x: number;
  y: number;
  z: number;
  /** Screen-x component of the plate's in-plane horizontal axis: cos of its yaw. */
  ux: number;
  /** Cosine between the visible face's normal and the light, in -1..1. */
  lit: number;
}

export interface MobileEnd {
  shape: MobileShape | null;
  arm: MobileArm | null;
}

export interface MobileArm {
  depth: number;
  /** Horizontal distance from the pivot to end 0 (one way) and end 1 (the other). */
  a: number;
  b: number;
  /** Droop: the wire is at height -curve * s² / (a + b) at distance s from the pivot. */
  curve: number;
  /** Length of the wire this arm hangs from. */
  drop: number;
  ends: [MobileEnd, MobileEnd];
  /** Yaw: yaw0 + Σ amp sin(freq τ + phase). */
  yaw0: number;
  amp: number[];
  freq: number[];
  phase: number[];
  /** Swing of the hanging wire: frequency (rad/s), phase, ellipse, gust delay (s). */
  swingFreq: number;
  swingPhase: number;
  swingEcc: number;
  gustDelay: number;
  // Pose, written by poseMobile: the top of the hanging wire, the pivot and the yaw.
  topX: number;
  topY: number;
  topZ: number;
  px: number;
  py: number;
  pz: number;
  yaw: number;
}

export interface Mobile {
  /** Top arm; arms in pre-order (parents first); all shapes. */
  root: MobileArm;
  arms: MobileArm[];
  shapes: MobileShape[];
  /** Hook point on the top edge. */
  hookX: number;
  hookY: number;
  /** The region the mobile stays inside, whatever the pose. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** z of the wall, behind every part. */
  wallZ: number;
  /** Gust envelope phases. */
  gust: [number, number];
}

/** Motion state, kept apart from the tree so a rebuild keeps time running. */
export interface MobileMotion {
  /** Seconds. */
  t: number;
  /** Draught phase: advances faster as the air moves more. */
  tau: number;
  /** Smoothed draught, 0..1. */
  level: number;
}

export function createMotion(draught: number): MobileMotion {
  return { t: 0, tau: 0, level: clamp(draught, 0, 1) };
}

/** Draught phase rate at draught 0 and its gain per unit of draught. */
const TAU_RATE = 0.4;
const TAU_GAIN = 0.9;
/** Smoothed draught follows the param at this rate per second. */
const LEVEL_RATE = 0.2;

export function stepMotion(m: MobileMotion, dt: number, draught: number): void {
  const d = clamp(Number.isFinite(draught) ? draught : 0, 0, 1);
  m.level = approach(m.level, d, dt * LEVEL_RATE);
  m.t += dt;
  m.tau += dt * (TAU_RATE + TAU_GAIN * m.level);
}

/** Gust envelope, 0..1: smooth and mostly 0, rising now and then as a draught passes. */
export function gustAt(mobile: Mobile, t: number): number {
  const g = mobile.gust;
  const w = 0.5 + 0.5 * (0.6 * Math.sin(0.13 * t + g[0]) + 0.4 * Math.sin(0.057 * t + g[1]));
  return smoothstep(0.42, 0.95, w);
}

/** Subtree extents relative to its pivot, for placing ends so nothing collides. */
interface Extent {
  mass: number;
  /** Lowest and highest y below / above the pivot (lo ≤ 0). */
  lo: number;
  hi: number;
  /** Largest horizontal distance from the pivot's vertical, including swing. */
  reach: number;
}

type Rng = () => number;

function pickKind(rng: Rng): ShapeKind {
  const u = rng();
  return u < 0.45 ? SHAPE_DISC : u < 0.75 ? SHAPE_PETAL : SHAPE_CRESCENT;
}

function pickSlot(rng: Rng): number {
  let u = rng();
  for (let i = 0; i < PALETTE_SLOTS - 1; i++) {
    u -= SLOT_WEIGHTS[i];
    if (u < 0) {
      return i;
    }
  }
  return PALETTE_SLOTS - 1;
}

function makeShape(rng: Rng, depth: number): MobileShape {
  const kind = pickKind(rng);
  const r = 0.095 * 0.86 ** depth * (0.72 + 0.4 * rng());
  // Most plates lie in the plane of their wire; a few are set across it.
  const twist = rng() < 0.2 ? Math.PI / 2 + (rng() - 0.5) * 0.4 : (rng() - 0.5) * 0.7;
  return {
    kind,
    r,
    mass: r * r * shapeArea(kind),
    colour: pickSlot(rng),
    twist,
    spin: rng() * Math.PI * 2,
    stub: r * STUB,
    x: 0,
    y: 0,
    z: 0,
    ux: 1,
    lit: 0,
  };
}

interface Builder {
  rng: Rng;
  levels: number;
  spread: number;
  /** How far an arm may be lengthened so its ends clear each other. */
  stretch: number;
  arms: number;
  /** Extents of every arm built so far. */
  extents: Map<MobileArm, Extent>;
}

/** Height of a tip at distance s from the pivot. */
function droop(arm: MobileArm, s: number): number {
  return (-arm.curve * s * s) / (arm.a + arm.b);
}

/** The extent recorded for `arm`, which must already be built. */
function extentOf(b: Builder, arm: MobileArm): Extent {
  const e = b.extents.get(arm);
  if (!e) {
    throw new Error("Mobile: an arm's extent is needed before it is built");
  }
  return e;
}

function endExtent(b: Builder, end: MobileEnd, ext: Extent): void {
  if (end.shape) {
    const s = end.shape;
    ext.mass = s.mass;
    ext.lo = -s.stub - s.r;
    ext.hi = Math.max(0, s.r - s.stub);
    ext.reach = s.r;
  } else {
    const a = end.arm;
    if (!a) {
      throw new Error("Mobile: an end has neither a shape nor an arm");
    }
    const e = extentOf(b, a);
    ext.mass = e.mass;
    ext.lo = e.lo - a.drop;
    ext.hi = Math.max(0, e.hi - a.drop);
    ext.reach = e.reach + a.drop * SWING_MAX;
  }
}

function buildArm(b: Builder, depth: number, main: boolean): MobileArm {
  const { rng } = b;
  b.arms++;
  const length = 0.36 * 0.8 ** depth * b.spread * (main ? 1 : 0.62) * (0.85 + 0.3 * rng());
  // Which end carries the main chain on: alternate sides now and then.
  const mainSide = rng() < 0.5 ? 0 : 1;
  const ends: [MobileEnd, MobileEnd] = [
    { shape: null, arm: null },
    { shape: null, arm: null },
  ];
  for (let i = 0; i < 2; i++) {
    const deeper = depth < b.levels - 1;
    const branch =
      deeper &&
      b.arms < MAX_ARMS &&
      ((main && i === mainSide) || rng() < (depth === 0 ? 0.75 : 0.45));
    if (branch) {
      ends[i].arm = buildArm(b, depth + 1, main && i === mainSide);
    } else {
      ends[i].shape = makeShape(rng, depth);
    }
  }
  const amp = [0.85 + 0.4 * rng(), 0.35 + 0.3 * rng(), 0.12 + 0.15 * rng()];
  // Smaller arms turn a little faster; a wide mobile turns more slowly.
  const lively = (1 + 0.3 * depth) / Math.sqrt(b.spread);
  const freq = [0.05, 0.11, 0.23].map((f) => f * lively * (0.8 + 0.45 * rng()));
  const arm: MobileArm = {
    depth,
    a: 0,
    b: 0,
    curve: -0.05 + 0.18 * rng(),
    drop: DROP_MIN,
    ends,
    yaw0: (rng() - 0.5) * 1.2,
    amp,
    freq,
    phase: [rng(), rng(), rng()].map((p) => p * Math.PI * 2),
    swingFreq: 1.0 + 0.6 * rng(),
    swingPhase: rng() * Math.PI * 2,
    swingEcc: 0.2 + 0.5 * rng(),
    gustDelay: depth * (1.5 + 2 * rng()),
    topX: 0,
    topY: 0,
    topZ: 0,
    px: 0,
    py: 0,
    pz: 0,
    yaw: 0,
  };
  balanceAndStack(b, arm, length);
  return arm;
}

/**
 * Places the pivot so the arm balances, then lengthens the sub-mobiles' hanging
 * wires so nothing can collide: every sub-mobile hangs below the arm wire, and below
 * its sibling too unless their reaches can't overlap whichever way they turn.
 */
function balanceAndStack(b: Builder, arm: MobileArm, length: number): void {
  const e0: Extent = { mass: 0, lo: 0, hi: 0, reach: 0 };
  const e1: Extent = { mass: 0, lo: 0, hi: 0, reach: 0 };
  endExtent(b, arm.ends[0], e0);
  endExtent(b, arm.ends[1], e1);
  // Two plates on one arm never touch. Ends that turn past each other get a longer
  // arm to clear each other, if that doesn't stretch it too far (else they stack,
  // below). The slack covers the reach the hanging wires gain below.
  const clear = e0.reach + e1.reach + MARGIN;
  const turning = arm.ends[0].arm !== null || arm.ends[1].arm !== null;
  if (!turning) {
    length = Math.max(length, clear);
  } else if (clear > length && clear < length * b.stretch) {
    length = clear + MARGIN;
  }
  // Torque balance: m0 a = m1 b with a + b = length.
  arm.a = (length * e1.mass) / (e0.mass + e1.mass);
  arm.b = (length * e0.mass) / (e0.mass + e1.mass);
  const tips = [droop(arm, arm.a), droop(arm, arm.b)];
  const wireLo = Math.min(0, tips[0], tips[1]);
  const wireHi = Math.max(0, tips[0], tips[1]);
  const exts = [e0, e1];
  // Sub-mobiles clear the arm wire.
  for (let i = 0; i < 2; i++) {
    const sub = arm.ends[i].arm;
    if (!sub) {
      continue;
    }
    const top = tips[i] + exts[i].hi;
    if (top > wireLo - MARGIN) {
      sub.drop += top - (wireLo - MARGIN);
      endExtent(b, arm.ends[i], exts[i]);
    }
  }
  // Ends that turn independently and could reach each other: hang one below the other.
  if (turning && e0.reach + e1.reach + MARGIN > length) {
    // The upper end is a shape if there is one, else the shorter subtree.
    let lower = arm.ends[0].arm ? 0 : 1;
    if (arm.ends[0].arm && arm.ends[1].arm) {
      lower = e0.lo < e1.lo ? 0 : 1;
    }
    const upper = 1 - lower;
    const floor = tips[upper] + exts[upper].lo - MARGIN;
    const top = tips[lower] + exts[lower].hi;
    const sub = arm.ends[lower].arm;
    if (top > floor) {
      if (!sub) {
        throw new Error("Mobile: the lower end to hang has no arm");
      }
      sub.drop += top - floor;
      endExtent(b, arm.ends[lower], exts[lower]);
    }
  }
  b.extents.set(arm, {
    mass: e0.mass + e1.mass,
    lo: Math.min(wireLo, tips[0] + e0.lo, tips[1] + e1.lo),
    hi: Math.max(wireHi, tips[0] + e0.hi, tips[1] + e1.hi),
    reach: Math.max(arm.a + e0.reach, arm.b + e1.reach),
  });
}

function collect(arm: MobileArm, arms: MobileArm[], shapes: MobileShape[]): void {
  arms.push(arm);
  for (const end of arm.ends) {
    if (end.arm) {
      collect(end.arm, arms, shapes);
    } else if (end.shape) {
      shapes.push(end.shape);
    }
  }
}

function scaleArm(arm: MobileArm, k: number): void {
  arm.a *= k;
  arm.b *= k;
  arm.drop *= k;
  for (const end of arm.ends) {
    if (end.arm) {
      scaleArm(end.arm, k);
    } else if (end.shape) {
      const s = end.shape;
      s.r *= k;
      s.mass *= k * k;
      s.stub *= k;
    }
  }
}

/** Builds the mobile for a seed, depth (2..4 arms down the main chain), side and aspect. */
export function createMobile(seed: number, levels: number, side: string, aspect: number): Mobile {
  const rng = createRng(Math.floor(seed) * 7919 + 101);
  const region = regionFor(side, aspect);
  const n = clamp(
    Math.round(Number.isFinite(levels) ? levels : MIN_LEVELS),
    MIN_LEVELS,
    MAX_LEVELS,
  );
  const b: Builder = {
    rng,
    levels: n,
    spread: region.spread,
    stretch: region.stretch,
    arms: 0,
    extents: new Map(),
  };
  const root = buildArm(b, 0, true);
  const ext = extentOf(b, root);
  // Fit the region: the hanging wire plus the tree's height, and its reach.
  const height = TOP_DROP + Math.max(0, ext.hi) - ext.lo;
  const reach = ext.reach + (TOP_DROP + Math.max(0, ext.hi)) * SWING_MAX;
  const k = Math.min(MAX_FIT, region.halfWidth / reach, region.height / height);
  scaleArm(root, k);
  root.drop = (TOP_DROP + Math.max(0, ext.hi)) * k;
  const arms: MobileArm[] = [];
  const shapes: MobileShape[] = [];
  collect(root, arms, shapes);
  return {
    root,
    arms,
    shapes,
    hookX: region.x,
    hookY: 1,
    x0: region.x - region.halfWidth,
    x1: region.x + region.halfWidth,
    y0: 1 - region.height,
    y1: 1,
    wallZ: -(reach * k + 0.06),
    gust: [rng() * Math.PI * 2, rng() * Math.PI * 2],
  };
}

/** Yaw of an arm at draught phase tau. */
export function armYaw(arm: MobileArm, tau: number): number {
  let y = arm.yaw0;
  for (let k = 0; k < arm.amp.length; k++) {
    y += arm.amp[k] * Math.sin(arm.freq[k] * tau + arm.phase[k]);
  }
  return y;
}

/** Largest |yaw - yaw0| an arm can reach. */
export function maxYawOffset(arm: MobileArm): number {
  let s = 0;
  for (const a of arm.amp) {
    s += a;
  }
  return s;
}

/** Light direction (towards the light: up, left and in front), normalised. */
const LIGHT_RAW = [-0.45, 0.55, 0.7];
const LIGHT_LEN = Math.hypot(LIGHT_RAW[0], LIGHT_RAW[1], LIGHT_RAW[2]);
const LX = LIGHT_RAW[0] / LIGHT_LEN;
const LZ = LIGHT_RAW[2] / LIGHT_LEN;
/** Largest dot product a vertical plate's normal can have with the light. */
const LXZ = Math.hypot(LX, LZ);

function poseArm(
  mobile: Mobile,
  arm: MobileArm,
  motion: MobileMotion,
  ax: number,
  ay: number,
  az: number,
): void {
  // The hanging wire swings a little while a gust passes.
  const amp = arm.drop * SWING_MAX * motion.level * gustAt(mobile, motion.t - arm.gustDelay);
  const w = arm.swingFreq * motion.t + arm.swingPhase;
  const hx = amp * Math.sin(w);
  const hz = amp * arm.swingEcc * Math.cos(w);
  arm.topX = ax;
  arm.topY = ay;
  arm.topZ = az;
  arm.px = ax + hx;
  arm.py = ay - Math.sqrt(Math.max(0, arm.drop * arm.drop - hx * hx - hz * hz));
  arm.pz = az + hz;
  arm.yaw = armYaw(arm, motion.tau);
  const c = Math.cos(arm.yaw);
  const s = Math.sin(arm.yaw);
  for (let i = 0; i < 2; i++) {
    const d = i === 0 ? -arm.a : arm.b;
    const tx = arm.px + c * d;
    const ty = arm.py + droop(arm, d);
    const tz = arm.pz + s * d;
    const end = arm.ends[i];
    if (end.arm) {
      poseArm(mobile, end.arm, motion, tx, ty, tz);
    } else if (end.shape) {
      const sh = end.shape;
      sh.x = tx;
      sh.y = ty - sh.stub;
      sh.z = tz;
      const yaw = arm.yaw + sh.twist;
      // Plate axis (cos, 0, sin); normal (-sin, 0, cos), flipped to face the viewer.
      sh.ux = Math.cos(yaw);
      const nx = -Math.sin(yaw);
      const nz = Math.cos(yaw);
      const facing = nz < 0 ? -1 : 1;
      sh.lit = (facing * (nx * LX + nz * LZ)) / LXZ;
    }
  }
}

/** Poses every arm and shape for the current motion state. */
export function poseMobile(mobile: Mobile, motion: MobileMotion): void {
  poseArm(mobile, mobile.root, motion, mobile.hookX, mobile.hookY, 0);
}

function writeSegment(
  out: Float32Array,
  n: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): number {
  const o = n * WIRE_FLOATS;
  out[o] = x0;
  out[o + 1] = y0;
  out[o + 2] = z0;
  out[o + 3] = x1;
  out[o + 4] = y1;
  out[o + 5] = z1;
  return n + 1;
}

/**
 * Writes the posed wires as segments (`WIRE_FLOATS` each): every hanging wire, arm
 * curve and shape stub. Returns the number of segments.
 */
export function writeWires(mobile: Mobile, out: Float32Array): number {
  let n = 0;
  for (const arm of mobile.arms) {
    n = writeSegment(out, n, arm.topX, arm.topY, arm.topZ, arm.px, arm.py, arm.pz);
    const c = Math.cos(arm.yaw);
    const s = Math.sin(arm.yaw);
    const len = arm.a + arm.b;
    let px = arm.px - c * arm.a;
    let py = arm.py + droop(arm, arm.a);
    let pz = arm.pz - s * arm.a;
    for (let k = 1; k <= ARM_SEGMENTS; k++) {
      const d = -arm.a + (len * k) / ARM_SEGMENTS;
      const x = arm.px + c * d;
      const y = arm.py + droop(arm, d);
      const z = arm.pz + s * d;
      n = writeSegment(out, n, px, py, pz, x, y, z);
      px = x;
      py = y;
      pz = z;
    }
    for (const end of arm.ends) {
      const sh = end.shape;
      if (sh) {
        n = writeSegment(out, n, sh.x, sh.y + sh.stub, sh.z, sh.x, sh.y, sh.z);
      }
    }
  }
  return n;
}
