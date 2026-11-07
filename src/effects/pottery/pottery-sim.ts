/**
 * Pure JS side of the Pottery Wheel effect (pottery.ts): the pot's radius
 * profile through the throwing cycle, the wheel's layout in its corner, and the
 * clay palettes.
 *
 * Screen units are "height units": x runs 0..aspect across the canvas and y
 * 0..1 from the bottom up. The wheel and pot are modelled in "pot units", the
 * same as height units on a 16:9 frame; the layout scales them down a little on
 * narrower frames so the wheel stays in the outer third.
 *
 * The pot is a surface of revolution: a radius r(u) at PROFILE_N evenly spaced
 * heights u = 0..1 along its height H. Keyframe shapes (mound, cylinder, and
 * the vase, bowl and jar) are blended over the cycle, and H is solved so the
 * clay's volume stays the same throughout.
 */
import { lookup } from "../lookup";
import { clamp, smoothstep } from "../math";
import type { ClayId, PotteryFormId } from "./pottery.meta";

/** Radius samples along the pot's height (the 1D profile texture's width). */
export const PROFILE_N = 64;
/** Sine and cosine of the view's tilt: the wheel is seen from slightly above. */
export const TILT_S = 0.24;
export const TILT_C = Math.sqrt(1 - TILT_S * TILT_S);

/** Wheel head radius and thickness; its top is at pot height 0. */
export const WHEEL_R = 0.15;
export const WHEEL_T = 0.022;
/** Splash tray radius, rim top and floor heights (below the wheel head's top). */
export const TRAY_R = 0.235;
export const TRAY_RIM_Y = -0.012;
export const TRAY_FLOOR_Y = -0.06;
/** Wheel centre's distance from its frame edge, and the wheel head top's screen height. */
export const WHEEL_EDGE_X = 0.34;
export const WHEEL_TOP_Y = 0.2;
/** Visible rim width at the pot's opening. */
export const RIM_W = 0.008;
/** Throwing rings: pitch (pot units) and slow drift (radians per second). */
export const RING_PITCH = 0.0125;
export const RING_DRIFT = 0.15;
/** Off-centre wobble at the top of the pot, pot units. */
export const WOBBLE = 0.0014;

/** A keyframe shape: radii at CTRL_N evenly spaced heights, its height, and how open its top is. */
export interface PotShape {
  /** Radii (pot units) at u = 0, 0.2, ..., 1. */
  readonly points: readonly number[];
  /** Height at which the shape holds CLAY_VOLUME (pot units). */
  readonly height: number;
  /** 0: a closed, flat top; 1: fully opened, a hollow pot with a rim. */
  readonly open: number;
}

export const CTRL_N = 6;

export const MOUND: PotShape = {
  points: [0.13, 0.126, 0.116, 0.1, 0.078, 0.052],
  height: 0.12,
  open: 0,
};
export const CYLINDER: PotShape = {
  points: [0.088, 0.082, 0.079, 0.077, 0.076, 0.076],
  height: 0.27,
  open: 1,
};
export const FORMS: Readonly<Record<Exclude<PotteryFormId, "cycle">, PotShape>> = {
  vase: { points: [0.062, 0.094, 0.098, 0.066, 0.043, 0.056], height: 0.36, open: 1 },
  bowl: { points: [0.058, 0.092, 0.115, 0.128, 0.136, 0.14], height: 0.18, open: 1 },
  jar: { points: [0.076, 0.104, 0.114, 0.106, 0.08, 0.072], height: 0.3, open: 1 },
};
/** The order "Cycle" throws the forms in, one per cycle. */
export const CYCLE_FORMS = ["vase", "bowl", "jar"] as const;

/** Cycle fractions: centre the mound, pull a cylinder, shape the form, hold, sink back. */
export const STAGES = [0.1, 0.32, 0.55, 0.8] as const;

const heightAt = (i: number) => i / (PROFILE_N - 1);

/** A shape's radius at height fraction u (Catmull-Rom through its points, clamped ends). */
export function shapeRadius(points: readonly number[], u: number): number {
  const x = clamp(u, 0, 1) * (points.length - 1);
  const i = Math.min(Math.floor(x), points.length - 2);
  const t = x - i;
  const p0 = points[Math.max(i - 1, 0)];
  const p1 = points[i];
  const p2 = points[i + 1];
  const p3 = points[Math.min(i + 2, points.length - 1)];
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (p2 - p0) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (3 * p1 - p0 - 3 * p2 + p3) * t3)
  );
}

/** Clay cross-section at radius r: a disc, less the hole once the top is opened. */
export function crossSection(r: number, wall: number, open: number): number {
  const hole = open * Math.max(r - wall, 0);
  return Math.PI * (r * r - hole * hole);
}

/** Volume of a sampled profile (trapezoid rule over PROFILE_N samples). */
export function profileVolume(
  radius: ArrayLike<number>,
  height: number,
  wall: number,
  open: number,
): number {
  return height * meanSection(radius, wall, open);
}

function meanSection(radius: ArrayLike<number>, wall: number, open: number): number {
  let sum = 0;
  for (let i = 0; i < PROFILE_N; i++) {
    const a = crossSection(radius[i], wall, open);
    sum += i === 0 || i === PROFILE_N - 1 ? 0.5 * a : a;
  }
  return sum / (PROFILE_N - 1);
}

/** Sampled radii of a shape. */
export function sampleShape(shape: PotShape, out = new Float64Array(PROFILE_N)): Float64Array {
  for (let i = 0; i < PROFILE_N; i++) {
    out[i] = shapeRadius(shape.points, heightAt(i));
  }
  return out;
}

/** The clay's volume: the solid mound. */
export const CLAY_VOLUME = profileVolume(sampleShape(MOUND), MOUND.height, 1, 0);

/**
 * The wall thickness at which an opened shape holds CLAY_VOLUME at its own
 * height (bisection: the volume grows with the wall). A closed shape's wall
 * doesn't matter, so it gets its largest radius.
 */
export function wallFor(shape: PotShape): number {
  const radius = sampleShape(shape);
  let lo = 0;
  let hi = Math.max(...radius);
  if (shape.open === 0) {
    return hi;
  }
  for (let k = 0; k < 50; k++) {
    const mid = 0.5 * (lo + hi);
    if (profileVolume(radius, shape.height, mid, shape.open) < CLAY_VOLUME) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

interface Baked {
  radius: Float64Array;
  wall: number;
  open: number;
}
const bake = (shape: PotShape): Baked => ({
  radius: sampleShape(shape),
  wall: wallFor(shape),
  open: shape.open,
});
const BAKED_MOUND = bake(MOUND);
const BAKED_CYLINDER = bake(CYLINDER);
const BAKED_FORMS = {
  vase: bake(FORMS.vase),
  bowl: bake(FORMS.bowl),
  jar: bake(FORMS.jar),
};

/** The current pot: sampled radii, height, wall and openness. */
export interface Profile {
  readonly radius: Float32Array;
  height: number;
  wall: number;
  open: number;
}

export function createProfile(): Profile {
  return { radius: new Float32Array(PROFILE_N), height: MOUND.height, wall: 0, open: 0 };
}

const isFormId = (id: string): id is Exclude<PotteryFormId, "cycle"> => Object.hasOwn(FORMS, id);

/** Which form a cycle throws: the chosen one, or the next in CYCLE_FORMS for "Cycle" (or an unknown id). */
export function formFor(form: string, cycleIndex: number): Exclude<PotteryFormId, "cycle"> {
  if (isFormId(form)) {
    return form;
  }
  const n = CYCLE_FORMS.length;
  return CYCLE_FORMS[((Math.floor(cycleIndex) % n) + n) % n];
}

function blend(a: Baked, b: Baked, t: number, out: Profile): Profile {
  const w = smoothstep(0, 1, t);
  for (let i = 0; i < PROFILE_N; i++) {
    out.radius[i] = a.radius[i] + (b.radius[i] - a.radius[i]) * w;
  }
  out.wall = a.wall + (b.wall - a.wall) * w;
  out.open = a.open + (b.open - a.open) * w;
  out.height = CLAY_VOLUME / meanSection(out.radius, out.wall, out.open);
  return out;
}

/**
 * The pot at `phase` cycles since the start (unwrapped: the integer part picks
 * the form under "Cycle"): mound, then a cylinder, then the form, held, then
 * back to the mound. Allocates nothing.
 */
export function profileAt(phase: number, form: string, out: Profile): Profile {
  const cycle = Math.floor(phase);
  const f = phase - cycle;
  const shaped = BAKED_FORMS[formFor(form, cycle)];
  const [s0, s1, s2, s3] = STAGES;
  if (f < s0) {
    return blend(BAKED_MOUND, BAKED_MOUND, 0, out);
  }
  if (f < s1) {
    return blend(BAKED_MOUND, BAKED_CYLINDER, (f - s0) / (s1 - s0), out);
  }
  if (f < s2) {
    return blend(BAKED_CYLINDER, shaped, (f - s1) / (s2 - s1), out);
  }
  if (f < s3) {
    return blend(shaped, shaped, 0, out);
  }
  return blend(shaped, BAKED_MOUND, (f - s3) / (1 - s3), out);
}

/**
 * Eases `shown` towards `target` by fraction `k` (0..1), so a param change
 * (another form, mid-cycle) reshapes the clay instead of jumping.
 */
export function relaxProfile(shown: Profile, target: Profile, k: number): Profile {
  for (let i = 0; i < PROFILE_N; i++) {
    shown.radius[i] += (target.radius[i] - shown.radius[i]) * k;
  }
  shown.height += (target.height - shown.height) * k;
  shown.wall += (target.wall - shown.wall) * k;
  shown.open += (target.open - shown.open) * k;
  return shown;
}

/** Copies `src` into `dst`. */
export function copyProfile(src: Profile, dst: Profile): Profile {
  dst.radius.set(src.radius);
  dst.height = src.height;
  dst.wall = src.wall;
  dst.open = src.open;
  return dst;
}

/** The largest radius of a profile. */
export function maxRadius(p: Profile): number {
  let m = 0;
  for (let i = 0; i < PROFILE_N; i++) {
    m = Math.max(m, p.radius[i]);
  }
  return m;
}

/** Radius of the opening's hole, inside the visible rim. */
export function holeRadius(p: Profile): number {
  return clamp(p.open, 0, 1) * Math.max(p.radius[PROFILE_N - 1] - RIM_W, 0);
}

export interface PotteryLayout {
  /** Outer direction: +1 in the bottom-right corner, -1 bottom-left. */
  side: 1 | -1;
  /** Height units per pot unit (1 on 16:9 and wider). */
  scale: number;
  /** Wheel centre x and the wheel head top's centre y (height units). */
  cx: number;
  baseY: number;
  /** Wheel and tray pass bounds: x0, y0, x1, y1 (height units). */
  wheelBox: [number, number, number, number];
}

export function createLayout(): PotteryLayout {
  return { side: 1, scale: 1, cx: 0, baseY: WHEEL_TOP_Y, wheelBox: [0, 0, 0, 0] };
}

/** Places the wheel in its corner for a frame `aspect` wide. */
export function potteryLayout(aspect: number, corner: string, out: PotteryLayout): PotteryLayout {
  const side = corner === "left" ? -1 : 1;
  const k = clamp(aspect / (16 / 9), 0.75, 1);
  const edge = WHEEL_EDGE_X * k;
  out.side = side;
  out.scale = k;
  out.cx = side > 0 ? aspect - edge : edge;
  out.baseY = WHEEL_TOP_Y;
  const m = 0.01;
  const halfW = (TRAY_R + m) * k;
  out.wheelBox[0] = out.cx - halfW;
  out.wheelBox[1] = 0;
  out.wheelBox[2] = out.cx + halfW;
  out.wheelBox[3] = out.baseY + (TRAY_RIM_Y * TILT_C + TRAY_R * TILT_S + m) * k;
  return out;
}

/** The pot pass bounds for a profile (x0, y0, x1, y1, height units), wobble included. */
export function potBox(
  layout: PotteryLayout,
  p: Profile,
  out: [number, number, number, number],
): [number, number, number, number] {
  const k = layout.scale;
  const r = maxRadius(p) + WOBBLE + 0.006;
  const rTop = p.radius[PROFILE_N - 1] + 0.006;
  out[0] = layout.cx - r * k;
  out[2] = layout.cx + r * k;
  out[1] = layout.baseY - (p.radius[0] * TILT_S + 0.006) * k;
  out[3] = layout.baseY + (p.height * TILT_C + rTop * TILT_S) * k;
  return out;
}

export interface Clay {
  /** Wet albedo, linear-ish 0..1. */
  color: readonly [number, number, number];
  /** Specular strength: how glossy the wet surface is. */
  shine: number;
}

export const CLAYS: Readonly<Record<ClayId, Clay>> = {
  terracotta: { color: [0.56, 0.27, 0.15], shine: 0.55 },
  stoneware: { color: [0.43, 0.41, 0.38], shine: 0.5 },
  porcelain: { color: [0.8, 0.78, 0.74], shine: 0.4 },
};

export function clayFor(id: string): Clay {
  return lookup(CLAYS, id, "terracotta");
}
