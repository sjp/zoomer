/**
 * Pure JS parts of the origami cranes effect (cranes.ts): the folded crane mesh
 * and its wing hinge, the instance rotation, the flight paths with their flap
 * events, the hanging mobile, the paper palettes and skies, and the per-frame
 * instance and thread data. Nothing here touches GL, so it is all unit tested.
 *
 * Units: positions are "height units", where the canvas is 1 tall and `aspect`
 * wide, y up from the bottom edge. The mesh is in "crane units": x forward
 * (towards the head), y up, z to the crane's right; its wingspan is about 2.
 * Screen space for rotations is x right, y up, z towards the viewer.
 */
import { hexToUnitRgb, type Rgb } from "../color";
import { lookup } from "../lookup";
import { clamp } from "../math";
import { createRng } from "../noise";
import type { PALETTE_OPTIONS, SKY_OPTIONS } from "./cranes.meta";
import { MAX_CRANES, MIN_CRANES, MOBILE_CRANES } from "./cranes.meta";

const TAU = Math.PI * 2;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Mesh (crane units)
// ---------------------------------------------------------------------------

/** Height of the wing hinge, which runs along x through z = 0 inside the body. */
export const HINGE_Y = 0.03;
/** The body: a flattened octahedron, with these half-extents. */
export const BODY_FRONT = 0.32;
export const BODY_TOP = 0.08;
export const BODY_BOTTOM = 0.2;
export const BODY_SIDE = 0.07;

type Vec3 = readonly [number, number, number];

/**
 * One triangle: three corners, the part it belongs to (each part is a closed
 * surface of its own), and its wing side (+1 right wing, -1 left, 0 for parts
 * that don't flap).
 */
interface MeshTriangle {
  readonly v: readonly [Vec3, Vec3, Vec3];
  readonly part: number;
  readonly side: number;
}

/** Body corners. */
const F: Vec3 = [BODY_FRONT, 0, 0];
const B: Vec3 = [-BODY_FRONT, 0, 0];
const T: Vec3 = [0, BODY_TOP, 0];
const K: Vec3 = [0, -BODY_BOTTOM, 0];
const R: Vec3 = [0, 0, BODY_SIDE];
const L: Vec3 = [0, 0, -BODY_SIDE];

/** Where a hanging crane's thread is tied: the top of its back. */
export const TIE_POINT: Vec3 = T;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Unit normal of the triangle (a, b, c), counter-clockwise front. */
export function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const n = cross(sub(b, a), sub(c, a));
  const len = Math.hypot(n[0], n[1], n[2]);
  return [n[0] / len, n[1] / len, n[2] / len];
}

function buildTriangles(): MeshTriangle[] {
  const out: MeshTriangle[] = [];
  // Body: eight faces, each wound to face away from the origin (inside the body).
  let part = 0;
  for (const x of [F, B]) {
    for (const y of [T, K]) {
      for (const z of [R, L]) {
        const n = triangleNormal(x, y, z);
        const centre: Vec3 = [x[0] + y[0] + z[0], x[1] + y[1] + z[1], x[2] + y[2] + z[2]];
        out.push({ v: dot(n, centre) > 0 ? [x, y, z] : [x, z, y], part, side: 0 });
      }
    }
  }
  /** A paper flap: both sides of each facet, so the part is closed. */
  const sheet = (facets: readonly (readonly [Vec3, Vec3, Vec3])[], side: number) => {
    part++;
    for (const [a, b, c] of facets) {
      out.push({ v: [a, b, c], part, side });
      out.push({ v: [a, c, b], part, side });
    }
  };
  // Neck: a narrow flap rising forward from the front of the body, and the head
  // folded forward from the neck's leading edge.
  const neckTip: Vec3 = [0.66, 0.46, 0];
  const neckBase: Vec3 = [0.18, -0.08, 0];
  sheet([[F, neckTip, neckBase]], 0);
  const headFold: Vec3 = [F[0] + 0.85 * (neckTip[0] - F[0]), F[1] + 0.85 * (neckTip[1] - F[1]), 0];
  sheet([[neckTip, headFold, [0.8, 0.36, 0]]], 0);
  // Tail: the neck's mirror image, without a head.
  sheet([[B, [-0.18, -0.08, 0], [-0.74, 0.42, 0]]], 0);
  // Wings: two creased facets each, hinged on the body's ridge.
  for (const side of [1, -1]) {
    const front: Vec3 = [0.16, HINGE_Y, 0];
    const back: Vec3 = [-0.16, HINGE_Y, 0];
    const trail: Vec3 = [-0.22, HINGE_Y - 0.05, 0.42 * side];
    const tip: Vec3 = [-0.12, HINGE_Y + 0.02, 0.98 * side];
    sheet(
      [
        [front, back, trail],
        [front, trail, tip],
      ],
      side,
    );
  }
  return out;
}

/** The crane, as a triangle list. */
export const CRANE_TRIANGLES: readonly MeshTriangle[] = buildTriangles();

/**
 * Per triangle, the index of the neighbouring triangle across the edge opposite
 * each corner (the edge from corner i + 1 to corner i + 2), within its part.
 * -1 where there is none, which `CRANE_TRIANGLES` never has: every part is closed.
 */
export const CRANE_NEIGHBOURS: readonly (readonly [number, number, number])[] = (() => {
  const key = (part: number, a: Vec3, b: Vec3) => `${String(part)}:${a.join(",")}|${b.join(",")}`;
  const normals = CRANE_TRIANGLES.map((t) => triangleNormal(t.v[0], t.v[1], t.v[2]));
  // Directed edge -> the triangles using it, per part.
  const edges = new Map<string, number[]>();
  CRANE_TRIANGLES.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const e = key(t.part, t.v[(k + 1) % 3], t.v[(k + 2) % 3]);
      edges.set(e, [...(edges.get(e) ?? []), i]);
    }
  });
  // Across a crease in a two-sided sheet, two triangles run each way along the
  // edge; the neighbour is the one on the same side of the paper, whose normal
  // is closest to this one's.
  return CRANE_TRIANGLES.map((t, i) => {
    const nb = [0, 1, 2].map((k) => {
      const candidates = edges.get(key(t.part, t.v[(k + 2) % 3], t.v[(k + 1) % 3])) ?? [];
      let best = -1;
      let bestDot = -Infinity;
      for (const j of candidates) {
        const d = dot(normals[i], normals[j]);
        if (d > bestDot) {
          best = j;
          bestDot = d;
        }
      }
      return best;
    });
    return [nb[0], nb[1], nb[2]] as const;
  });
})();

/** Vertices drawn per crane (a plain triangle list). */
export const CRANE_VERTICES = CRANE_TRIANGLES.length * 3;

/**
 * Floats per mesh vertex: rest position and wing side, own face normal, and the
 * three neighbours' face normals (for the silhouette edges).
 */
export const VERTEX_FLOATS = 16;

/** The interleaved vertex buffer for `CRANE_TRIANGLES`. */
export function buildCraneVertices(): Float32Array {
  const out = new Float32Array(CRANE_VERTICES * VERTEX_FLOATS);
  const normals = CRANE_TRIANGLES.map((t) => triangleNormal(t.v[0], t.v[1], t.v[2]));
  CRANE_TRIANGLES.forEach((t, i) => {
    const nb = CRANE_NEIGHBOURS[i];
    for (let k = 0; k < 3; k++) {
      const o = (i * 3 + k) * VERTEX_FLOATS;
      out.set(t.v[k], o);
      out[o + 3] = t.side;
      out.set(normals[i], o + 4);
      for (let e = 0; e < 3; e++) {
        out.set(normals[nb[e]], o + 7 + e * 3);
      }
    }
  });
  return out;
}

/**
 * Rotates a point (or, with `pivot` false, a direction) of wing `side` about the
 * hinge by `angle` (radians, positive raises the wingtip). Body parts (side 0)
 * stay as they are. Writes into `out`; the shader's `hinge` is its twin.
 */
export function hinge(
  p: Vec3,
  side: number,
  angle: number,
  pivot: boolean,
  out: [number, number, number],
): void {
  const c = Math.cos(angle * Math.abs(side));
  const s = Math.sin(angle * Math.abs(side)) * Math.sign(side);
  const y = p[1] - (pivot ? HINGE_Y : 0);
  out[0] = p[0];
  out[1] = (pivot ? HINGE_Y : 0) + y * c + p[2] * s;
  out[2] = -y * s + p[2] * c;
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/**
 * The instance rotation, column-major into `out` (9 floats): roll about the
 * crane's own x axis, then pitch (nose up), then yaw (heading: 0 faces right,
 * π left; positive turns the nose away from the viewer), then the view tilt
 * about the screen's x axis (positive shows the underside, as when looking up).
 */
export function craneMatrix(
  yaw: number,
  pitch: number,
  roll: number,
  tilt: number,
  out: Float32Array | Float64Array,
  offset = 0,
): void {
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  for (let col = 0; col < 3; col++) {
    // Basis vector `col` through each rotation in turn.
    let x = col === 0 ? 1 : 0;
    let y = col === 1 ? 1 : 0;
    let z = col === 2 ? 1 : 0;
    // Roll about x.
    let t = y * cr - z * sr;
    z = y * sr + z * cr;
    y = t;
    // Pitch about z.
    t = x * cp - y * sp;
    y = x * sp + y * cp;
    x = t;
    // Yaw about y.
    t = x * cy + z * sy;
    z = -x * sy + z * cy;
    x = t;
    // Tilt about the screen x axis, the underside towards the viewer.
    t = y * ct + z * st;
    z = -y * st + z * ct;
    y = t;
    out[offset + col * 3] = x;
    out[offset + col * 3 + 1] = y;
    out[offset + col * 3 + 2] = z;
  }
}

// ---------------------------------------------------------------------------
// Flapping
// ---------------------------------------------------------------------------

/** Wing angle while gliding: a shallow V. */
export const GLIDE = 0.3;
/** A flap's stroke amplitude and its mean lift above the glide. */
const FLAP_AMP = 0.5;
const FLAP_LIFT = 0.15;
/** Seconds per wingbeat. */
const FLAP_PERIOD = 0.8;
/** Wingbeats per flap event. */
const FLAP_CYCLES_MIN = 2;
const FLAP_CYCLES_MAX = 3;
/** Seconds of gliding between flap events. */
const FLAP_GAP_MIN = 5;
const FLAP_GAP_MAX = 14;
/** Bounds of `flapAngle`. */
export const FLAP_MIN = GLIDE + FLAP_LIFT - FLAP_AMP;
export const FLAP_MAX = GLIDE + FLAP_LIFT + FLAP_AMP;

/**
 * Wing angle `u` (0..1) of the way through a flap event of `cycles` wingbeats:
 * a sine stroke under a smooth envelope that is 0 at both ends, so it starts and
 * ends at the glide angle with no jump.
 */
export function flapAngle(u: number, cycles: number): number {
  const v = clamp(u, 0, 1);
  const env = Math.sin(Math.PI * v) ** 2;
  return GLIDE + env * (FLAP_LIFT + FLAP_AMP * Math.sin(TAU * cycles * v));
}

// ---------------------------------------------------------------------------
// Flight
// ---------------------------------------------------------------------------

/** Crane size (height units per crane unit) at depth 0 (far) and 1 (near). */
const SIZE_FAR = 0.05;
const SIZE_NEAR = 0.12;
/** Crane units from the origin to the farthest point of the mesh, plus a margin. */
export const EXTENT = 1.05;
/** Flight lanes (height units): above and below the central band the speaker covers. */
export const TOP_LANE: readonly [number, number] = [0.66, 0.9];
export const BOTTOM_LANE: readonly [number, number] = [0.1, 0.3];
/** Share of cranes in the top lane. */
const TOP_SHARE = 0.6;
/** Vertical bob amplitude (height units) and rate (radians per second). */
const BOB_AMP = 0.022;
const BOB_RATE: readonly [number, number] = [0.25, 0.45];
/** Heading wobble amplitude (radians) and rate; banking follows the turn rate. */
const SWAY_AMP = 0.18;
const SWAY_RATE: readonly [number, number] = [0.12, 0.25];
const BANK_PER_TURN = 0.25;
/** Heading turned towards or away from the viewer, so the wings show (radians). */
const QUARTER_YAW = 0.35;
/** View tilt: a little from below everywhere, more for cranes high in the frame. */
const TILT_BASE = 0.08;
const TILT_PER_Y = 0.6;
/** Haze towards the sky colour for the farthest cranes. */
const HAZE_FAR = 0.35;

const craneSize = (depth: number) => mix(SIZE_FAR, SIZE_NEAR, depth);
const craneHaze = (depth: number) => HAZE_FAR * (1 - depth);
/** Flight speed (height units per second at speed 1) for a depth and a 0..1 random. */
const craneSpeed = (depth: number, r: number) => (0.018 + 0.026 * depth) * (0.85 + 0.3 * r);

interface Flyer {
  /** Not on screen and not flying: waits to be spawned when the count allows. */
  parked: boolean;
  /** Centre x (height units). */
  x: number;
  /** Middle of the bob (height units). */
  lane: number;
  depth: number;
  /** +1 flying right, -1 left. */
  dir: number;
  /** Height units per second at speed 1. */
  speed: number;
  /** +1 nose towards the viewer, -1 away. */
  turn: number;
  bob: number;
  bobRate: number;
  sway: number;
  swayRate: number;
  /** Palette slot, 0..1. */
  tint: number;
  /** Seconds into the current flap event, or -1 while gliding. */
  flapAge: number;
  flapCycles: number;
  /** Seconds of glide left before the next flap event. */
  flapWait: number;
}

interface Hanger {
  /** Anchor x, as a fraction of the width. */
  anchor: number;
  /** Thread length (height units). */
  length: number;
  yaw: number;
  twist: number;
  twistRate: number;
  swing: number;
  swingRate: number;
  tint: number;
}

export interface Cranes {
  readonly flyers: Flyer[];
  readonly hangers: Hanger[];
  readonly rand: () => number;
  /** Hanging mobile clock (seconds at speed 1). */
  time: number;
}

const randIn = (rand: () => number, [lo, hi]: readonly [number, number]) => lo + (hi - lo) * rand();

/** Anchor x fractions for the mobile: clear of the middle third. */
const MOBILE_ANCHORS = [0.06, 0.19, 0.81, 0.94];
const THREAD_LENGTH: readonly [number, number] = [0.1, 0.26];
export const HANG_SIZE = 0.13;
const TWIST_AMP = 1.0;
/** Slow twist about the thread: amplitude (radians) and rate (radians per second). */
const TWIST_RATE: readonly [number, number] = [0.4, 0.65];
/** Gentle pendulum swing of the thread: amplitude (radians) and rate (radians per second). */
const SWING_AMP = 0.025;
const SWING_RATE: readonly [number, number] = [0.9, 1.3];
const HANG_TILT = 0.22;

/** Off-screen distance (height units) past which a crane at `depth` shows nothing. */
export const craneMargin = (depth: number) => craneSize(depth) * EXTENT + BOB_AMP;

/** Draws a new flight for `f`: lane, depth, direction, speed and look. */
function launch(f: Flyer, rand: () => number): void {
  f.parked = false;
  f.lane = rand() < TOP_SHARE ? randIn(rand, TOP_LANE) : randIn(rand, BOTTOM_LANE);
  f.depth = rand();
  f.dir = rand() < 0.5 ? -1 : 1;
  f.speed = craneSpeed(f.depth, rand());
  f.turn = rand() < 0.5 ? -1 : 1;
  f.bob = rand() * TAU;
  f.bobRate = randIn(rand, BOB_RATE);
  f.sway = rand() * TAU;
  f.swayRate = randIn(rand, SWAY_RATE);
  f.tint = rand();
  f.flapAge = -1;
  f.flapCycles = FLAP_CYCLES_MIN;
  f.flapWait = randIn(rand, [FLAP_GAP_MIN, FLAP_GAP_MAX]) * rand();
}

/** Puts `f` just off the edge it enters from. */
function enter(f: Flyer, aspect: number): void {
  const m = craneMargin(f.depth);
  f.x = f.dir > 0 ? -m : aspect + m;
}

/** Whether `f` has flown off the far side. */
const flownOff = (f: Flyer, aspect: number) =>
  f.dir > 0 ? f.x > aspect + craneMargin(f.depth) : f.x < -craneMargin(f.depth);

/** A crane field for `seed`: the first `count` cranes spread over the frame, the rest parked. */
export function createCranes(seed: number, aspect: number, count: number): Cranes {
  const rand = createRng(seed * 7919 + 93);
  const active = clamp(Math.round(count), MIN_CRANES, MAX_CRANES);
  const flyers: Flyer[] = [];
  for (let i = 0; i < MAX_CRANES; i++) {
    // Every field but x is drawn by launch.
    const f: Flyer = {
      parked: false,
      x: 0,
      lane: 0,
      depth: 0,
      dir: 0,
      speed: 0,
      turn: 0,
      bob: 0,
      bobRate: 0,
      sway: 0,
      swayRate: 0,
      tint: 0,
      flapAge: 0,
      flapCycles: 0,
      flapWait: 0,
    };
    launch(f, rand);
    const m = craneMargin(f.depth);
    // Stratified, so the opening frame isn't clumped.
    f.x = -m + ((i + rand()) / MAX_CRANES) * (aspect + 2 * m);
    f.parked = i >= active;
    flyers.push(f);
  }
  const hangers: Hanger[] = [];
  for (let i = 0; i < MOBILE_CRANES; i++) {
    hangers.push({
      anchor: MOBILE_ANCHORS[i % MOBILE_ANCHORS.length],
      length: randIn(rand, THREAD_LENGTH),
      yaw: rand() * TAU,
      twist: rand() * TAU,
      twistRate: randIn(rand, TWIST_RATE),
      swing: rand() * TAU,
      swingRate: randIn(rand, SWING_RATE),
      tint: rand(),
    });
  }
  return { flyers, hangers, rand, time: 0 };
}

/**
 * Advances every crane by `dt` seconds at `speed`. A crane that flies off the
 * far side starts a new flight from just off an edge, or parks if it is beyond
 * the first `count`; parked cranes within `count` launch from off-screen, so
 * changing the count never pops a crane in or out mid-frame.
 */
export function stepCranes(c: Cranes, dt: number, aspect: number, speed: number, count: number) {
  const active = clamp(Math.round(count), MIN_CRANES, MAX_CRANES);
  const k = Math.max(0, speed) * Math.max(0, dt);
  c.time += k;
  for (let i = 0; i < MAX_CRANES; i++) {
    const f = c.flyers[i];
    if (f.parked) {
      if (i < active) {
        launch(f, c.rand);
        enter(f, aspect);
      }
      continue;
    }
    f.x += f.dir * f.speed * k;
    f.bob = (f.bob + f.bobRate * k) % TAU;
    f.sway = (f.sway + f.swayRate * k) % TAU;
    if (f.flapAge >= 0) {
      f.flapAge += k;
      if (f.flapAge >= f.flapCycles * FLAP_PERIOD) {
        f.flapAge = -1;
        f.flapWait = randIn(c.rand, [FLAP_GAP_MIN, FLAP_GAP_MAX]);
      }
    } else {
      f.flapWait -= k;
      if (f.flapWait <= 0) {
        f.flapAge = 0;
        f.flapCycles = c.rand() < 0.5 ? FLAP_CYCLES_MIN : FLAP_CYCLES_MAX;
      }
    }
    if (flownOff(f, aspect)) {
      if (i < active) {
        launch(f, c.rand);
        enter(f, aspect);
      } else {
        f.parked = true;
      }
    }
  }
}

/** A crane's placement for drawing. */
interface Pose {
  /** Origin of the crane's mesh (height units). */
  x: number;
  y: number;
  /** Height units per crane unit. */
  size: number;
  yaw: number;
  pitch: number;
  roll: number;
  tilt: number;
  flap: number;
  /** Sort key: larger is nearer. */
  depth: number;
  haze: number;
  tint: number;
}

export const createPose = (): Pose => ({
  x: 0,
  y: 0,
  size: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  tilt: 0,
  flap: 0,
  depth: 0,
  haze: 0,
  tint: 0,
});

/** The pose of flyer `f` now. */
export function flyerPose(f: Flyer, out: Pose): void {
  out.x = f.x;
  out.y = f.lane + BOB_AMP * Math.sin(f.bob);
  out.size = craneSize(f.depth);
  // Climb rate over forward speed sets the pitch; the heading sways and the
  // crane banks into the turn.
  const climb = BOB_AMP * f.bobRate * Math.cos(f.bob);
  out.pitch = 0.04 + Math.atan(climb / Math.max(f.speed, 1e-3));
  const sway = SWAY_AMP * Math.sin(f.sway);
  const base = f.dir > 0 ? 0 : Math.PI;
  out.yaw = base + f.dir * (QUARTER_YAW * f.turn + sway);
  out.roll = -BANK_PER_TURN * Math.cos(f.sway);
  out.tilt = TILT_BASE + TILT_PER_Y * (out.y - 0.5);
  out.flap =
    f.flapAge >= 0 ? flapAngle(f.flapAge / (f.flapCycles * FLAP_PERIOD), f.flapCycles) : GLIDE;
  out.depth = f.depth;
  out.haze = craneHaze(f.depth);
  out.tint = f.tint;
}

/** Swing angle of hanger `h`'s thread from the vertical at mobile time `time`. */
function hangerSwing(h: Hanger, time: number): number {
  return SWING_AMP * Math.sin(h.swing + h.swingRate * time);
}

/**
 * The pose of hanging crane `h` at mobile time `time`, and its tie point
 * (height units) in `tie`: the thread's lower end, on the crane's back.
 */
export function hangerPose(
  h: Hanger,
  time: number,
  aspect: number,
  out: Pose,
  tie: [number, number],
  matrix: Float64Array,
): void {
  const swing = hangerSwing(h, time);
  tie[0] = h.anchor * aspect + h.length * Math.sin(swing);
  tie[1] = 1 - h.length * Math.cos(swing);
  out.size = HANG_SIZE;
  out.yaw = h.yaw + TWIST_AMP * Math.sin(h.twist + h.twistRate * time);
  out.pitch = 0;
  out.roll = 0;
  out.tilt = HANG_TILT;
  out.flap = GLIDE;
  out.depth = 1.5;
  out.haze = 0;
  out.tint = h.tint;
  craneMatrix(out.yaw, out.pitch, out.roll, out.tilt, matrix);
  // Hang the crane so its tie point meets the thread.
  out.x = tie[0] - HANG_SIZE * (matrix[0] * TIE_POINT[0] + matrix[3] * TIE_POINT[1]);
  out.y = tie[1] - HANG_SIZE * (matrix[1] * TIE_POINT[0] + matrix[4] * TIE_POINT[1]);
}

// ---------------------------------------------------------------------------
// Palettes and skies
// ---------------------------------------------------------------------------

/** Washi print on a crane: none, stripes or dots. */
const PATTERN_NONE = 0;
export const PATTERN_STRIPES = 1;
export const PATTERN_DOTS = 2;

interface PaperColour {
  readonly base: Rgb;
  readonly print: Rgb;
  readonly pattern: number;
}

const plain = (hex: string): PaperColour => {
  const c = hexToUnitRgb(hex);
  return { base: c, print: c, pattern: PATTERN_NONE };
};
const printed = (base: string, print: string, pattern: number): PaperColour => ({
  base: hexToUnitRgb(base),
  print: hexToUnitRgb(print),
  pattern,
});

/** Paper colours per palette, in the `papercut.ts` tones where they overlap. */
export const PALETTES: Record<(typeof PALETTE_OPTIONS)[number]["value"], readonly PaperColour[]> = {
  pastel: ["#f4978e", "#ffd6a5", "#cfe3f0", "#7d8fcf", "#b8e0d2", "#f6c6ea", "#fbf3c4"].map((v) =>
    plain(v),
  ),
  washi: [
    printed("#c8553d", "#f3e6c8", PATTERN_DOTS),
    printed("#13426b", "#f2b84b", PATTERN_STRIPES),
    printed("#2f5d3a", "#f3e6c8", PATTERN_DOTS),
    printed("#f28c5a", "#fdf6ec", PATTERN_STRIPES),
    printed("#7d8fcf", "#fbf7ee", PATTERN_DOTS),
    printed("#4a2340", "#fbd3a2", PATTERN_STRIPES),
    plain("#f6dcc0"),
  ],
  white: ["#fbf7ee", "#f3efe6", "#ffffff", "#f2efe8"].map((v) => plain(v)),
  rainbow: ["#e5604f", "#f4a261", "#e9c46a", "#7cb87f", "#4f8fc0", "#8a6bb5"].map((v) => plain(v)),
};

export function paletteFor(id: string): readonly PaperColour[] {
  return lookup(PALETTES, id, "pastel");
}

export const paperFor = (palette: readonly PaperColour[], tint: number) =>
  palette[Math.min(palette.length - 1, Math.floor(tint * palette.length))];

interface Sky {
  readonly top: Rgb;
  readonly bottom: Rgb;
}

export const SKIES: Record<(typeof SKY_OPTIONS)[number]["value"], Sky> = {
  dawn: { top: hexToUnitRgb("#cdd8ee"), bottom: hexToUnitRgb("#f9d6c9") },
  blue: { top: hexToUnitRgb("#b7d2ea"), bottom: hexToUnitRgb("#eef4f8") },
  paper: { top: hexToUnitRgb("#ece2cc"), bottom: hexToUnitRgb("#f8f2e4") },
};

export function skyFor(id: string): Sky {
  return lookup(SKIES, id, "dawn");
}

/** Thread colour and half width (px at 1080p). */
export const THREAD: Rgb = hexToUnitRgb("#6f665c");
export const THREAD_HALF_WIDTH = 0.6;

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

/**
 * Floats per crane instance:
 * - 0–3: rotation column 0, flap angle;
 * - 4–7: rotation column 1, size (px per crane unit);
 * - 8–11: rotation column 2, depth slot (clip z);
 * - 12–15: origin x, y (px, y up), pattern, haze;
 * - 16–18: base colour; 19–21: print colour.
 */
export const INSTANCE_FLOATS = 22;
/** Most instances drawn: every flyer and the mobile. */
export const MAX_INSTANCES = MAX_CRANES + MOBILE_CRANES;
/** The span of clip z the instances share, and how much of its slot a crane's own depth uses. */
const Z_SPAN = 1.8;
const Z_SHARE = 0.4;

/** Clip-z scale per crane unit of depth when `n` instances share the depth range. */
export const zScale = (n: number) => (Z_SHARE * Z_SPAN) / Math.max(1, n);

/** Scratch, so writing instances allocates nothing. */
interface InstanceScratch {
  readonly poses: Pose[];
  readonly order: Int32Array;
  readonly matrix: Float64Array;
  readonly tie: [number, number];
  /** Thread ends (height units): anchor x, tie x, tie y per hanger. */
  readonly threads: Float64Array;
}

export function createInstanceScratch(): InstanceScratch {
  const poses: Pose[] = [];
  for (let i = 0; i < MAX_INSTANCES; i++) {
    poses.push(createPose());
  }
  return {
    poses,
    order: new Int32Array(MAX_INSTANCES),
    matrix: new Float64Array(9),
    tie: [0, 0],
    threads: new Float64Array(MOBILE_CRANES * 3),
  };
}

/**
 * Poses every visible crane, sorts them far to near, and writes their instance
 * data into `out`. Each takes its own slot of clip z, nearer cranes nearer, so
 * one depth-tested draw keeps every crane in front of those drawn before it.
 * Fills `s.threads` for the mobile. Returns the instance count.
 */
export function writeInstances(
  c: Cranes,
  mobile: boolean,
  palette: readonly PaperColour[],
  width: number,
  height: number,
  s: InstanceScratch,
  out: Float32Array,
): number {
  const aspect = width / height;
  let n = 0;
  for (const f of c.flyers) {
    if (f.parked) {
      continue;
    }
    flyerPose(f, s.poses[n]);
    n++;
  }
  if (mobile) {
    for (let i = 0; i < c.hangers.length; i++) {
      const h = c.hangers[i];
      hangerPose(h, c.time, aspect, s.poses[n], s.tie, s.matrix);
      s.threads[i * 3] = h.anchor * aspect;
      s.threads[i * 3 + 1] = s.tie[0];
      s.threads[i * 3 + 2] = s.tie[1];
      n++;
    }
  }
  // Insertion sort by depth, far first: a couple of dozen entries.
  const order = s.order;
  for (let i = 0; i < n; i++) {
    let j = i;
    const d = s.poses[i].depth;
    while (j > 0 && s.poses[order[j - 1]].depth > d) {
      order[j] = order[j - 1];
      j--;
    }
    order[j] = i;
  }
  const slot = Z_SPAN / Math.max(1, n);
  for (let r = 0; r < n; r++) {
    const p = s.poses[order[r]];
    const o = r * INSTANCE_FLOATS;
    const m = s.matrix;
    craneMatrix(p.yaw, p.pitch, p.roll, p.tilt, m);
    for (let col = 0; col < 3; col++) {
      out[o + col * 4] = m[col * 3];
      out[o + col * 4 + 1] = m[col * 3 + 1];
      out[o + col * 4 + 2] = m[col * 3 + 2];
    }
    out[o + 3] = p.flap;
    out[o + 7] = p.size * height;
    out[o + 11] = Z_SPAN / 2 - (r + 0.5) * slot;
    out[o + 12] = p.x * height;
    out[o + 13] = p.y * height;
    const paper = paperFor(palette, p.tint);
    out[o + 14] = paper.pattern;
    out[o + 15] = p.haze;
    out[o + 16] = paper.base[0];
    out[o + 17] = paper.base[1];
    out[o + 18] = paper.base[2];
    out[o + 19] = paper.print[0];
    out[o + 20] = paper.print[1];
    out[o + 21] = paper.print[2];
  }
  return n;
}
