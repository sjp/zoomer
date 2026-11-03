/**
 * Pure JS side of the Record Player effect (turntable.ts): the turntable's
 * layout in its corner, the view projection and its inverse, the record's
 * rotation, the tonearm's play / lift / return cycle and its projected
 * geometry, the room's bokeh lights, and the plinth and room palettes.
 *
 * Screen units are "height units": x runs 0..aspect across the canvas and y
 * 0..1 from the bottom up. The turntable is modelled in "world" units (the
 * same size as height units at scale 1): X to the right, Y up, Z away from
 * the viewer, with the origin at the record's centre on the plinth's top
 * face. The view is orthographic, looking down at ELEVATION, so a world point
 * lands at local screen (X, Z sin e + Y cos e), and the layout's origin and
 * scale take local screen units to height units.
 */
import { clamp, smoothstep, wrap } from "./math";
import { createRng } from "./noise";
import type { PlinthId, RpmId, TurntableRoomId } from "./turntable.meta";

/** View elevation above the horizontal (radians), and its projection factors. */
export const ELEVATION = (25 * Math.PI) / 180;
/** Screen y per unit of world Z (depth foreshortening). */
export const VIEW_K = Math.sin(ELEVATION);
/** Screen y per unit of world Y (height). */
export const VIEW_V = Math.cos(ELEVATION);

/** Record radius, label radius, spindle radius. A 12" LP: 150 mm, label 50 mm. */
export const RECORD_R = 0.145;
export const LABEL_R = 0.049;
export const SPINDLE_R = 0.0035;
/** Grooved band: lead-in (outer) to run-out (inner) radius. */
export const GROOVE_OUT = 0.14;
export const GROOVE_IN = 0.067;
/** Smooth gaps between tracks: radii, and half-width. */
export const TRACK_GAPS = [0.0825, 0.0965, 0.1105, 0.1255] as const;
export const GAP_HALF = 0.0009;
/** Platter radius and height above the plinth, and the record's top surface height. */
export const PLATTER_R = 0.151;
export const PLATTER_H = 0.016;
export const RECORD_Y = 0.0185;

/** Plinth extent from the record centre (world units), and its height. */
export const PLINTH_LEFT = 0.185;
export const PLINTH_RIGHT = 0.3;
export const PLINTH_FRONT = 0.175;
export const PLINTH_BACK = 0.17;
export const PLINTH_H = 0.05;

/** Tonearm pivot (world X, Z), its height, and the base cylinder's radius and height. */
export const PIVOT_X = 0.215;
export const PIVOT_Z = 0.1;
export const ARM_Y = 0.036;
export const PIVOT_BASE_R = 0.026;
export const PIVOT_BASE_H = 0.018;
/** Pivot to record centre, and the arm's effective length (pivot to stylus), with a little overhang. */
export const PIVOT_D = Math.hypot(PIVOT_X, PIVOT_Z);
export const ARM_L = PIVOT_D + 0.016;
/** Headshell length, cartridge height above the stylus tip, and the lift height. */
export const HEAD_LEN = 0.042;
export const CART_H = 0.009;
export const LIFT_H = 0.014;
/** Counterweight: span behind the pivot. */
export const WEIGHT_NEAR = 0.014;
export const WEIGHT_FAR = 0.056;
/** Finger lift length, out from the headshell's side. */
export const FINGER_LEN = 0.016;

/** Gap from the frame's side edge to the plinth, and from the bottom (height units). */
export const EDGE_X = 0.05;
export const EDGE_Y = 0.045;
/** Slack around the plinth for its soft shadow on the surface below (local units). */
export const SHADOW_PAD = 0.065;
/** The turntable shrinks to keep its inner edge within this fraction of the width. */
export const MAX_WIDTH_FRAC = 0.38;
/** The far edge of the surface the turntable stands on, local screen y. */
export const SURFACE_BACK = PLINTH_BACK * VIEW_K + 0.03 - PLINTH_H * VIEW_V;

/** Local screen y range of everything drawn (plinth bottom shadow up to the lifted arm). */
const LOCAL_BOTTOM = -PLINTH_FRONT * VIEW_K - PLINTH_H * VIEW_V - SHADOW_PAD;
const LOCAL_TOP = PLINTH_BACK * VIEW_K + (ARM_Y + LIFT_H) * VIEW_V + 0.03;
const LOCAL_LEFT = -PLINTH_LEFT - SHADOW_PAD;
const LOCAL_RIGHT = PLINTH_RIGHT + SHADOW_PAD;

export interface TurntableLayout {
  /** +1 if the turntable is in the bottom-right corner, -1 bottom-left. */
  side: 1 | -1;
  /** Height units per local unit (at most 1). */
  scale: number;
  /** The record centre on the plinth's top face, in height units. */
  ox: number;
  oy: number;
  /** Turntable pass bounds in height units, clamped to the frame: x0, y0, x1, y1. */
  box: [number, number, number, number];
}

export const createLayout = (): TurntableLayout => ({
  side: 1,
  scale: 1,
  ox: 0,
  oy: 0,
  box: [0, 0, 0, 0],
});

/** Lays the turntable out in its corner of an `aspect`-wide frame. */
export function turntableLayout(
  aspect: number,
  position: string,
  out: TurntableLayout,
): TurntableLayout {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const side = position === "left" ? -1 : 1;
  const span = PLINTH_LEFT + PLINTH_RIGHT + SHADOW_PAD;
  const scale = clamp((a * MAX_WIDTH_FRAC - EDGE_X) / span, 0.2, 1);
  out.side = side;
  out.scale = scale;
  out.ox = side > 0 ? a - EDGE_X - PLINTH_RIGHT * scale : EDGE_X + PLINTH_LEFT * scale;
  out.oy = EDGE_Y + (PLINTH_FRONT * VIEW_K + PLINTH_H * VIEW_V) * scale;
  out.box[0] = Math.max(0, out.ox + LOCAL_LEFT * scale);
  out.box[1] = Math.max(0, out.oy + LOCAL_BOTTOM * scale);
  out.box[2] = Math.min(a, out.ox + LOCAL_RIGHT * scale);
  out.box[3] = Math.min(1, out.oy + LOCAL_TOP * scale);
  return out;
}

/** World (X, Y, Z) to local screen units, written to `out` [x, y]. */
export function project(x: number, y: number, z: number, out: Float64Array | number[]): void {
  out[0] = x;
  out[1] = z * VIEW_K + y * VIEW_V;
}

/**
 * Local screen (sx, sy) back to the record's polar coordinates on its top
 * surface (Y = RECORD_Y), written to `out` [radius, angle]. The angle is
 * atan2(Z, X) in world space, before the record's rotation.
 */
export function screenToRecord(sx: number, sy: number, out: Float64Array | number[]): void {
  const x = sx;
  const z = (sy - RECORD_Y * VIEW_V) / VIEW_K;
  out[0] = Math.hypot(x, z);
  out[1] = Math.atan2(z, x);
}

/** The record's polar coordinates to local screen units, written to `out` [x, y]. */
export function recordToScreen(r: number, angle: number, out: Float64Array | number[]): void {
  project(r * Math.cos(angle), RECORD_Y, r * Math.sin(angle), out);
}

/** Revolutions per second for an `rpm` select value; unknown values fall back to 33⅓. */
export function revsPerSecond(rpm: string): number {
  return (rpm === ("45" satisfies RpmId) ? 45 : 100 / 3) / 60;
}

/**
 * Advances the record's rotation, in revolutions wrapped to [0, 1), by `dt`
 * seconds at `rps`. The record turns clockwise seen from above, so the
 * label's material angle is the world angle plus 2π times this.
 */
export function advanceRotation(rot: number, rps: number, dt: number): number {
  const step = Number.isFinite(dt) && dt > 0 ? dt * rps : 0;
  return wrap(Number.isFinite(rot) ? rot + step : 0, 0, 1);
}

/** Revolutions to play one side, from lead-in to run-out (constant groove pitch). */
export const SIDE_REVS = 500;
/** Where a new instance starts: a little way into the side. */
export const START_REVS = 40;
/** The return cycle: in the run-out groove, lifting, swinging out, lowering (seconds). */
export const RUNOUT_S = 6;
export const LIFT_S = 1.6;
export const SWING_S = 5;
export const LOWER_S = 2.2;
export const RETURN_S = RUNOUT_S + LIFT_S + SWING_S + LOWER_S;

export interface ArmState {
  /** Revolutions played into the side, 0..SIDE_REVS. */
  revs: number;
  /** Seconds into the return cycle, or -1 while playing. */
  ret: number;
}

export const createArmState = (): ArmState => ({ revs: START_REVS, ret: -1 });

/**
 * Advances the tonearm by `dt` seconds with the record at `rps`. While
 * playing it tracks revolutions (so a speed change doesn't jump it); at the
 * end of the side it rides the run-out groove, lifts, swings back to the
 * lead-in, lowers, and plays again. Leftover time carries across the switch.
 */
export function advanceArm(s: ArmState, dt: number, rps: number): ArmState {
  let left = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const speed = Number.isFinite(rps) && rps > 0 ? rps : 0;
  // Two switches at most per call: dt is far shorter than either stage.
  for (let i = 0; i < 3 && left > 0; i++) {
    if (s.ret < 0) {
      const toEnd = speed > 0 ? (SIDE_REVS - s.revs) / speed : Infinity;
      if (left < toEnd) {
        s.revs += left * speed;
        return s;
      }
      left -= Math.max(0, toEnd);
      s.revs = SIDE_REVS;
      s.ret = 0;
    } else {
      const toEnd = RETURN_S - s.ret;
      if (left < toEnd) {
        s.ret += left;
        return s;
      }
      left -= toEnd;
      s.revs = 0;
      s.ret = -1;
    }
  }
  return s;
}

export interface ArmPose {
  /** The groove radius under the stylus. */
  r: number;
  /** 0: stylus in the groove, 1: fully lifted. */
  lift: number;
}

export const createArmPose = (): ArmPose => ({ r: GROOVE_OUT, lift: 0 });

/** The stylus radius and lift for an arm state. */
export function armPose(s: ArmState, out: ArmPose): ArmPose {
  if (s.ret < 0) {
    const u = clamp(s.revs / SIDE_REVS, 0, 1);
    out.r = GROOVE_OUT + (GROOVE_IN - GROOVE_OUT) * u;
    out.lift = 0;
    return out;
  }
  let t = s.ret - RUNOUT_S;
  if (t < LIFT_S) {
    out.r = GROOVE_IN;
    out.lift = smoothstep(0, LIFT_S, t);
    return out;
  }
  t -= LIFT_S;
  if (t < SWING_S) {
    out.r = GROOVE_IN + (GROOVE_OUT - GROOVE_IN) * smoothstep(0, SWING_S, t);
    out.lift = 1;
    return out;
  }
  t -= SWING_S;
  out.r = GROOVE_OUT;
  out.lift = 1 - smoothstep(0, LOWER_S, t);
  return out;
}

/**
 * The arm's angle about the pivot (world XZ, radians from +X) that puts the
 * stylus at groove radius `r`: the arm swings from the back right, so the
 * stylus lands on the record's front-right quarter.
 */
export function armAngle(r: number): number {
  const base = Math.atan2(-PIVOT_Z, -PIVOT_X);
  const c = (PIVOT_D * PIVOT_D + ARM_L * ARM_L - r * r) / (2 * PIVOT_D * ARM_L);
  return base + Math.acos(clamp(c, -1, 1));
}

/** Direction towards the key light (world, before mirroring for the side), not normalised. */
export const LIGHT = [0.45, 0.78, 0.42] as const;

/** Unit light direction for a side: the lamp is on the outer side, above and behind. */
export function lightDir(side: number, out: Float64Array | number[]): void {
  const l = Math.hypot(LIGHT[0], LIGHT[1], LIGHT[2]);
  out[0] = (Math.sign(side) || 1) * (LIGHT[0] / l);
  out[1] = LIGHT[1] / l;
  out[2] = LIGHT[2] / l;
}

/**
 * Offsets into `armGeometry`'s output: segment ends (ax, ay, bx, by) in local
 * screen units for the tube, headshell, counterweight and finger lift, then
 * the tube's and headshell's shadows.
 */
export const ARM_TUBE = 0;
export const ARM_HEAD = 4;
export const ARM_WEIGHT = 8;
export const ARM_FINGER = 12;
export const ARM_TUBE_SHADOW = 16;
export const ARM_HEAD_SHADOW = 20;
export const ARM_FLOATS = 24;

const tmp = new Float64Array(2);

/** Projects a world point, or its shadow along `light` onto the surface below it, into `out` at `i`. */
function put(
  out: Float32Array,
  i: number,
  x: number,
  y: number,
  z: number,
  light: Float64Array | null,
): void {
  if (light) {
    const ys = Math.hypot(x, z) < PLATTER_R ? RECORD_Y : 0;
    const h = Math.max(0, y - ys);
    x -= (light[0] / light[1]) * h;
    z -= (light[2] / light[1]) * h;
    y = ys;
  }
  project(x, y, z, tmp);
  out[i] = tmp[0];
  out[i + 1] = tmp[1];
}

/**
 * The tonearm's projected segments for a pose (see the ARM_* offsets): the
 * tube from the pivot to the headshell, the headshell down to the stylus,
 * the counterweight behind the pivot, the finger lift sticking out from the
 * headshell, and the shadows along `light` (unit, world).
 */
export function armGeometry(pose: ArmPose, light: Float64Array, out: Float32Array): Float32Array {
  const phi = armAngle(pose.r);
  const dx = Math.cos(phi);
  const dz = Math.sin(phi);
  const sy = RECORD_Y + CART_H + clamp(pose.lift, 0, 1) * LIFT_H;
  const hx = PIVOT_X + dx * (ARM_L - HEAD_LEN);
  const hz = PIVOT_Z + dz * (ARM_L - HEAD_LEN);
  const sx = PIVOT_X + dx * ARM_L;
  const sz = PIVOT_Z + dz * ARM_L;
  // Perpendicular to the arm, pointing away from the record's centre.
  let px = dz;
  let pz = -dx;
  if (px * sx + pz * sz < 0) {
    px = -px;
    pz = -pz;
  }
  const mx = (hx + sx) / 2;
  const mz = (hz + sz) / 2;
  put(out, ARM_TUBE, PIVOT_X, ARM_Y, PIVOT_Z, null);
  put(out, ARM_TUBE + 2, hx, sy, hz, null);
  put(out, ARM_HEAD, hx, sy, hz, null);
  put(out, ARM_HEAD + 2, sx, sy, sz, null);
  put(out, ARM_WEIGHT, PIVOT_X - dx * WEIGHT_NEAR, ARM_Y, PIVOT_Z - dz * WEIGHT_NEAR, null);
  put(out, ARM_WEIGHT + 2, PIVOT_X - dx * WEIGHT_FAR, ARM_Y, PIVOT_Z - dz * WEIGHT_FAR, null);
  put(out, ARM_FINGER, mx, sy, mz, null);
  put(out, ARM_FINGER + 2, mx + px * FINGER_LEN, sy + 0.002, mz + pz * FINGER_LEN, null);
  put(out, ARM_TUBE_SHADOW, PIVOT_X - dx * WEIGHT_FAR, ARM_Y, PIVOT_Z - dz * WEIGHT_FAR, light);
  put(out, ARM_TUBE_SHADOW + 2, hx, sy, hz, light);
  put(out, ARM_HEAD_SHADOW, hx, sy, hz, light);
  put(out, ARM_HEAD_SHADOW + 2, sx, sy, sz, light);
  return out;
}

/** Stylus tip position in world XZ for a groove radius, written to `out` [x, z]. */
export function stylusAt(r: number, out: Float64Array | number[]): void {
  const phi = armAngle(r);
  out[0] = PIVOT_X + Math.cos(phi) * ARM_L;
  out[1] = PIVOT_Z + Math.sin(phi) * ARM_L;
}

export interface PlinthLook {
  top: string;
  front: string;
  /** Wood grain strength (0: none). */
  grain: number;
  /** Specular strength of the finish. */
  gloss: number;
}

export const PLINTHS: Readonly<Record<PlinthId, PlinthLook>> = {
  walnut: { top: "#6e4127", front: "#4e2c18", grain: 1, gloss: 0.12 },
  black: { top: "#1f1e1d", front: "#141414", grain: 0, gloss: 0.08 },
  white: { top: "#d6d2ca", front: "#b5afa5", grain: 0, gloss: 0.1 },
};

/** The plinth for a select value; unknown values fall back to walnut. */
export function plinthFor(id: string): PlinthLook {
  return Object.hasOwn(PLINTHS, id) ? PLINTHS[id as PlinthId] : PLINTHS.walnut;
}

export interface RoomLook {
  /** 0: warm lamp, 1: window, 2: dark (the room shader's branch). */
  kind: number;
  wall: string;
  /** The sideboard the turntable stands on. */
  surface: string;
  /** Key light colour. */
  light: string;
  /** Bokeh colours, mixed per light. */
  bokehA: string;
  bokehB: string;
  /** Bokeh brightness. */
  bokeh: number;
  /** Ambient light on the turntable. */
  ambient: number;
  /** Seed for the bokeh layout. */
  seed: number;
}

export const ROOMS: Readonly<Record<TurntableRoomId, RoomLook>> = {
  lamp: {
    kind: 0,
    wall: "#5c3b28",
    surface: "#3b2619",
    light: "#ffc47e",
    bokehA: "#ffb25e",
    bokehB: "#ff8448",
    bokeh: 0.55,
    ambient: 0.3,
    seed: 3,
  },
  window: {
    kind: 1,
    wall: "#6a5b4f",
    surface: "#55402f",
    light: "#fff0db",
    bokehA: "#fff3df",
    bokehB: "#ffd49a",
    bokeh: 0.35,
    ambient: 0.42,
    seed: 8,
  },
  dark: {
    kind: 2,
    wall: "#1b1411",
    surface: "#140e0b",
    light: "#ffb36e",
    bokehA: "#ff9a4c",
    bokehB: "#4fa3b4",
    bokeh: 0.5,
    ambient: 0.16,
    seed: 21,
  },
};

/** The room for a select value; unknown values fall back to the warm lamp. */
export function roomFor(id: string): RoomLook {
  return Object.hasOwn(ROOMS, id) ? ROOMS[id as TurntableRoomId] : ROOMS.lamp;
}

/** Bokeh lights in the room, and their radius range (height units). */
export const BOKEH_COUNT = 14;
export const BOKEH_R = [0.03, 0.085] as const;

/**
 * The room's out-of-focus lights for a seed, written to `out` as BOKEH_COUNT
 * vec4s: x as a fraction of the width (0..1), y (height units, in the upper
 * part of the frame, above the turntable), radius, and brightness (0..1).
 */
export function bokehLights(seed: number, out: Float32Array): Float32Array {
  const rng = createRng(seed);
  for (let i = 0; i < BOKEH_COUNT; i++) {
    out[i * 4] = 0.03 + 0.94 * rng();
    out[i * 4 + 1] = 0.42 + 0.52 * rng();
    out[i * 4 + 2] = BOKEH_R[0] + (BOKEH_R[1] - BOKEH_R[0]) * rng();
    out[i * 4 + 3] = 0.35 + 0.65 * rng();
  }
  return out;
}
